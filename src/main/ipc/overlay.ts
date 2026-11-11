import type { IpcMain, WebContents } from 'electron'
import { screen, globalShortcut } from 'electron'
import type { IpcContext } from './types'
import { saveOverlayPosition } from '../services/overlay-position'
import { hasHudPrefs, readHudPrefs, seedHudPrefs, writeHudPrefs } from '../services/hud-prefs'
import { DEFAULT_HUD_PREFS, mergeHudPrefs, type HudPrefs } from '../../core/hud-prefs'
import { HUD_MIN_W, HUD_MAX_W, HUD_MIN_H } from '../../core/overlay-layout'
import { HUD_PASSTHROUGH_ACCELERATOR } from '../../core/shortcuts'

// ── Overlay state ───────────────────────────────────────────────────────────
let overlayMouseInside = false
let overlayTrackingInterval: ReturnType<typeof setInterval> | null = null

// While pass-through is on, mouse tracking is disabled entirely — the HUD
// stays ignore-mouse regardless of cursor position. Users who want the HUD to
// never steal a stray click (e.g. it's sitting over Burp) enable this in
// Settings > HUD; the opacity drops so it's clearly ghost-mode.
//
// The setting is `prefs.passThrough`, stored machine-wide. What the window
// does is `passThroughActive()`. An exposed IP turns the setting off (§8,
// below), so the two only differ if a setting of "on" reaches us while the
// address is already out — and then it is stored off at once.
let overlayIpExposed = false

/** §8: 0.85 at rest so the HUD sits over a terminal without hiding it; 1.0
 *  once the cursor is on it, which is also why click-through defaults to off —
 *  the hover response is the affordance that says the thing is interactive. */
const OVERLAY_REST_OPACITY = 0.85

// Stored reference to the context. Set by registerOverlayIpc.
let _ctx: IpcContext | null = null

// The HUD's settings (src/core/hud-prefs.ts): machine-wide, held here and in
// `<prefsDir>/hud-prefs.json`. `onPrefsApplied` is index.ts's share of
// applying them — the Dock icon and the tray menu.
let prefsDir: string | null = null
let prefs: HudPrefs = { ...DEFAULT_HUD_PREFS }
let onPrefsApplied: ((p: HudPrefs) => void) | null = null

function passThroughActive(): boolean {
  return prefs.passThrough && !overlayIpExposed
}

// The release chord is taken from every other application for as long as it
// is registered, so it is held only while there is something to release:
// ⌘⇧P is VS Code's palette and Burp's Proxy tab. There is also nothing to
// release while the HUD window is absent or hidden (a project closed), so the
// chord needs a visible window as well.
let releaseShortcutHeld = false
export function syncReleaseShortcut(): void {
  const hud = _ctx?.getOverlayWindow()
  const want = passThroughActive() && !!hud && !hud.isDestroyed() && hud.isVisible()
  if (want === releaseShortcutHeld) return
  if (want) {
    releaseShortcutHeld = globalShortcut.register(HUD_PASSTHROUGH_ACCELERATOR, () => setOverlayPassThrough(false))
    if (!releaseShortcutHeld) console.warn(`[shortcuts] ${HUD_PASSTHROUGH_ACCELERATOR} is taken by another application`)
  } else {
    globalShortcut.unregister(HUD_PASSTHROUGH_ACCELERATOR)
    releaseShortcutHeld = false
  }
}

function overlayOpacity(): number {
  // An exposed IP overrides the operator's preference — the one case §8 allows
  // that — so it is never the thing that faded into a screenshot.
  if (overlayIpExposed) return 1
  return overlayMouseInside ? 1 : OVERLAY_REST_OPACITY
}

export function applyOverlayOpacity(): void {
  const overlayWindow = _ctx?.getOverlayWindow()
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setOpacity(overlayOpacity())
}

export function applyOverlayPassThrough(): void {
  syncReleaseShortcut()
  if (!_ctx) return
  const overlayWindow = _ctx.getOverlayWindow()
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  applyOverlayOpacity()
  const active = passThroughActive()
  if (active) {
    stopOverlayMouseTracking()
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    _ctx.send(overlayWindow, 'overlay:interactive', false)
    overlayMouseInside = false
  } else {
    // Normal HUD mode is interactive. Do not make the whole native window
    // click-through while waiting for hover detection: if the OS does not
    // forward that first mouse move, the expand/hide controls can never
    // receive the event that would restore interaction. Operators who want
    // clicks to pass through have the explicit pass-through mode above.
    overlayWindow.setIgnoreMouseEvents(false)
    startOverlayMouseTracking()
  }
  _ctx.send(overlayWindow, 'overlay:passThrough', active, prefs.passThroughOpacity)
}

/** The one apply path for the HUD's settings: on window creation, on every
 *  project open and on every change. Pushes them to the HUD and puts the
 *  window's pass-through and opacity in line with them. */
export function applyHudPrefs(): void {
  // §8: a stored "on" does not outlive an exposed IP. Reached when the first
  // project opened while the address is out seeds "on" from its old block.
  if (overlayIpExposed && prefs.passThrough) {
    updateHudPrefs({ passThrough: false })
    return
  }
  applyOverlayPassThrough()
  const overlayWindow = _ctx?.getOverlayWindow()
  if (_ctx && overlayWindow && !overlayWindow.isDestroyed()) {
    _ctx.send(overlayWindow, 'overlay:showMark', prefs.showMarkButton)
    _ctx.send(overlayWindow, 'overlay:flashExposed', prefs.flashOnExposed)
    _ctx.send(overlayWindow, 'overlay:scale', prefs.scale)
    _ctx.send(overlayWindow, 'overlay:emphasizeIp', prefs.emphasizeExternalIp)
  }
  onPrefsApplied?.({ ...prefs })
}

export function hudPrefs(): HudPrefs {
  return { ...prefs }
}

/** Project open: the first one ever seeds the file from its old `overlay:`
 *  block; every later one reads the file and ignores the project's. */
export function openHudPrefs(legacyOverlay: unknown): HudPrefs {
  prefs = prefsDir ? seedHudPrefs(prefsDir, legacyOverlay) : mergeHudPrefs(DEFAULT_HUD_PREFS, legacyOverlay)
  return hudPrefs()
}

/** Any change to the HUD's settings, from any control. Stored, applied, and
 *  announced so Settings shows what the HUD button or ⌘⇧P just did.
 *
 *  §8: while the external IP is exposed, pass-through cannot be turned on from
 *  any entry — Settings, the HUD, the tray and the shortcut all come through
 *  here. The attempt is answered with the real state, so a checkbox that was
 *  just ticked unticks itself. */
export function updateHudPrefs(partial: unknown): HudPrefs {
  const refused = overlayIpExposed && !!partial && typeof partial === 'object'
    && (partial as { passThrough?: unknown }).passThrough === true
  if (refused) partial = { ...(partial as object), passThrough: false }
  const next = mergeHudPrefs(prefs, partial)
  const changed = JSON.stringify(next) !== JSON.stringify(prefs)
  if (changed || (prefsDir && !hasHudPrefs(prefsDir))) {
    prefs = next
    if (prefsDir) {
      try { writeHudPrefs(prefsDir, prefs) } catch (e) { console.error('[hud] could not store HUD settings:', e) }
    }
  }
  if (changed) applyHudPrefs()
  if (changed || refused) _ctx?.send(_ctx.getMainWindow(), 'hudPrefs:changed', hudPrefs())
  return hudPrefs()
}

// §8: the single operator toggle for pass-through, shared by the Settings
// checkbox and the HUD action-row button (on), the ⌘⇧P shortcut and the menu
// bar (off). It is the setting, so it is stored with the rest of them, and
// compared against the setting — so "off" is always stored.
export function setOverlayPassThrough(on: boolean): void {
  if (prefs.passThrough === on && !(on && overlayIpExposed)) return
  updateHudPrefs({ passThrough: on })
}

/** The same recovery chord must also work inside RedLog's own windows when
 * macOS does not deliver the registered global accelerator. Release only:
 * duplicate delivery by the global handler cannot turn pass-through back on. */
export function bindOverlayReleaseShortcut(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    const isMac = process.platform === 'darwin'
    if (input.type !== 'keyDown' || !input.shift || input.alt ||
      input.meta !== isMac || input.control === isMac || input.key.toLowerCase() !== 'p') return
    event.preventDefault()
    setOverlayPassThrough(false)
  })
}

export function startOverlayMouseTracking(): void {
  if (passThroughActive()) return
  if (overlayTrackingInterval) clearInterval(overlayTrackingInterval)
  overlayTrackingInterval = setInterval(() => {
    const overlayWindow = _ctx?.getOverlayWindow()
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return
    const point = screen.getCursorScreenPoint()
    const bounds = overlayWindow.getBounds()
    const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
                   point.y >= bounds.y && point.y <= bounds.y + bounds.height
    if (inside && !overlayMouseInside) {
      overlayMouseInside = true
      overlayWindow.webContents.send('overlay:interactive', true)
      applyOverlayOpacity()
    } else if (!inside && overlayMouseInside) {
      overlayMouseInside = false
      overlayWindow.webContents.send('overlay:interactive', false)
      applyOverlayOpacity()
    }
  }, 50)
}

export function stopOverlayMouseTracking(): void {
  if (overlayTrackingInterval) {
    clearInterval(overlayTrackingInterval)
    overlayTrackingInterval = null
  }
}

/**
 * Handle an IP-exposed state change from broadcastIPStatus.
 * §8: an exposed IP overrides the operator's HUD preferences — including a
 * HUD they closed or never had open: it comes back, without taking focus, and
 * stays until they close it again.
 */
export function handleIpExposedChange(exposed: boolean): void {
  if (exposed === overlayIpExposed) return
  overlayIpExposed = exposed
  const overlayWindow = _ctx?.getOverlayWindow()
  if (exposed && _ctx && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
    overlayWindow.showInactive()
    syncReleaseShortcut()
    _ctx.send(_ctx.getMainWindow(), 'overlay:visibilityChanged', true)
  }
  if (exposed && prefs.passThrough) {
    // The setting, not just the window: left stored as "on", the next project
    // open would put click-through back over a HUD that is warning the operator.
    // It stays off when the address is safe again; turning it on is their call.
    updateHudPrefs({ passThrough: false })
  } else {
    applyOverlayOpacity()
  }
}

/** The setting (an exposed IP stores it off). */
export function isOverlayPassThrough(): boolean {
  return prefs.passThrough
}

export function registerOverlayIpc(
  ipcMain: IpcMain,
  ctx: IpcContext,
  opts: { prefsDir?: string; onPrefsApplied?: (p: HudPrefs) => void } = {}
): void {
  _ctx = ctx
  prefsDir = opts.prefsDir ?? null
  onPrefsApplied = opts.onPrefsApplied ?? null
  prefs = prefsDir ? readHudPrefs(prefsDir) : { ...DEFAULT_HUD_PREFS }

  // Settings ▸ HUD. Not the project config: these do not change with it.
  ipcMain.handle('hudPrefs:get', () => hudPrefs())
  ipcMain.handle('hudPrefs:set', (_e, partial: unknown) => updateHudPrefs(partial))
  // The HUD's own view at mount. `passThrough` is what the window is doing;
  // later changes arrive on the per-key channels applyHudPrefs sends.
  ipcMain.handle('overlay:getPrefs', () => ({
    showMarkButton: prefs.showMarkButton,
    flashOnExposed: prefs.flashOnExposed,
    scale: prefs.scale,
    emphasizeExternalIp: prefs.emphasizeExternalIp,
    passThrough: passThroughActive(),
    passThroughOpacity: prefs.passThroughOpacity
  }))

  // The renderer measures its own content and reports the exact height it needs
  // (see OverlayApp) — no more guessing, so the panel never clips or leaves a
  // big empty gap. Clamp to sane bounds.
  ipcMain.on('overlay:autosize', (_e, height: number, width?: number) => {
    const overlayWindow = ctx.getOverlayWindow()
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const cur = overlayWindow.getBounds()
    let disp: Electron.Rectangle
    try { disp = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y }).workArea }
    catch { disp = screen.getPrimaryDisplay().workArea }
    const maxH = disp.height - 20
    const h = Math.max(HUD_MIN_H, Math.min(maxH, Math.round(Number(height) || HUD_MIN_H)))
    const w = width != null
      ? Math.max(HUD_MIN_W, Math.min(HUD_MAX_W, Math.round(Number(width))))
      : cur.width
    let x = cur.x
    let y = cur.y
    if (x + w > disp.x + disp.width) x = Math.max(disp.x, disp.x + disp.width - w)
    if (y + h > disp.y + disp.height) y = Math.max(disp.y, disp.y + disp.height - h)
    if (y < disp.y) y = disp.y
    overlayWindow.setBounds({ x, y, width: w, height: h })
    if (process.platform === 'win32') {
      overlayWindow.setOpacity(0.99)
      setImmediate(() => { if (!overlayWindow!.isDestroyed()) overlayWindow!.setOpacity(1) })
    }
  })
  // Snap HUD to one of the four corners of the display it's currently on —
  // driven by the main window's ⌘⌥ arrow shortcuts (audit finding #53). The
  // renderer just sends the compass direction; we compute bounds here so we
  // can pick the right display without asking the renderer to guess.
  ipcMain.on('overlay:moveToCorner', (_e, corner: 'tl' | 'tr' | 'bl' | 'br') => {
    const overlayWindow = ctx.getOverlayWindow()
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const b = overlayWindow.getBounds()
    try {
      const disp = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
      const pad = 16
      const x = corner === 'tl' || corner === 'bl' ? disp.x + pad : disp.x + disp.width - b.width - pad
      const y = corner === 'tl' || corner === 'tr' ? disp.y + pad : disp.y + disp.height - b.height - pad
      overlayWindow.setBounds({ x, y, width: b.width, height: b.height })
      saveOverlayPosition(overlayWindow)
    } catch { /* no display — bail */ }
  })
  ipcMain.on('overlay:hide', () => {
    ctx.getOverlayWindow()?.hide()
    syncReleaseShortcut()
    ctx.send(ctx.getMainWindow(), 'overlay:visibilityChanged', false)
  })
  ipcMain.on('overlay:toggle', () => {
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide()
    } else {
      overlayWindow?.show()
    }
    syncReleaseShortcut()
    ctx.send(ctx.getMainWindow(), 'overlay:visibilityChanged', overlayWindow?.isVisible() ?? false)
  })
  ipcMain.handle('overlay:isVisible', () => {
    return ctx.getOverlayWindow()?.isVisible() ?? false
  })
  ipcMain.on('overlay:mouseEnter', () => {
    if (passThroughActive()) return
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = true
      overlayWindow.webContents.send('overlay:interactive', true)
    }
  })
  ipcMain.on('overlay:mouseLeave', () => {
    if (passThroughActive()) return
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = false
      overlayWindow.webContents.send('overlay:interactive', false)
    }
  })

  // --- Quick mark / passthrough (overlay: prefix) ---
  ipcMain.on('overlay:quickMark', ctx.triggerBookmark)
  ipcMain.handle('overlay:beginMarker', () => ctx.hudMarkerBinding?.() ?? null)
  ipcMain.handle('overlay:addMarker', (_e, input: { title?: string; notes?: string; at?: number; bind?: string }) =>
    ctx.addHudMarker(input && typeof input === 'object' ? input : {}))
  // After the form closes the HUD gives focus back, so the operator returns to
  // the window they were working in.
  ipcMain.on('overlay:releaseFocus', () => {
    const w = ctx.getOverlayWindow()
    if (w && !w.isDestroyed()) w.blur()
  })
  // §8: the HUD action-row button turns pass-through ON (it can't turn it off —
  // once on, the HUD is click-through). The exits are ⌘⇧P and the menu bar.
  ipcMain.on('overlay:setPassThrough', (_e, on: boolean) => setOverlayPassThrough(!!on))
}
