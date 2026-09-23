import type { IpcMain } from 'electron'
import { screen } from 'electron'
import type { IpcContext } from './types'
import { saveOverlayPosition } from '../services/overlay-position'
import { loadConfig, saveConfig } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { HUD_MIN_W, HUD_MAX_W, HUD_MIN_H } from '../../core/overlay-layout'

// ── Overlay state ───────────────────────────────────────────────────────────
let overlayMouseInside = false
let overlayTrackingInterval: ReturnType<typeof setInterval> | null = null

// While `overlayPassThrough` is on, mouse tracking is disabled entirely —
// the HUD stays ignore-mouse regardless of cursor position. Users who want
// the HUD to never steal a stray click (e.g. it's sitting over Burp) enable
// this in Settings > HUD; the opacity drops so it's clearly ghost-mode.
let overlayPassThrough = false
let overlayPassThroughOpacity = 0.4
/** Set while the external IP is exposed. §8's single sanctioned override of
 *  the operator's own HUD preferences: pass-through off, fully opaque. */
let overlayIpExposed = false

/** §8: 0.85 at rest so the HUD sits over a terminal without hiding it; 1.0
 *  once the cursor is on it, which is also why click-through defaults to off —
 *  the hover response is the affordance that says the thing is interactive. */
const OVERLAY_REST_OPACITY = 0.85

// Stored reference to the context. Set by registerOverlayIpc.
let _ctx: IpcContext | null = null

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
  if (!_ctx) return
  const overlayWindow = _ctx.getOverlayWindow()
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  applyOverlayOpacity()
  if (overlayPassThrough) {
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
  _ctx.send(overlayWindow, 'overlay:passThrough', overlayPassThrough, overlayPassThroughOpacity)
}

// §8: the single operator toggle for pass-through, shared by the Settings
// checkbox and the HUD action-row button (on), the ⌘⇧P shortcut and the menu
// bar (off). It is the setting: stored, because every config save and project
// open re-applies what is stored, and the Settings page listens for the change.
export function setOverlayPassThrough(on: boolean): void {
  if (overlayPassThrough === on) return
  overlayPassThrough = on
  applyOverlayPassThrough()
  const project = _ctx?.getActiveProject()
  if (project) {
    const dir = getProjectPath(project)
    const cfg = loadConfig(dir)
    saveConfig(dir, { ...cfg, overlay: { ...cfg.overlay, passThrough: on } })
  }
  if (_ctx) _ctx.send(_ctx.getMainWindow(), 'overlay:passThroughChanged', on)
}

export function startOverlayMouseTracking(): void {
  if (overlayPassThrough) return
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
 * Configure overlay pass-through state. Called by startProject and config:save.
 */
export function configureOverlayState(opts: { passThrough: boolean; opacity: number }): void {
  overlayPassThrough = opts.passThrough
  overlayPassThroughOpacity = opts.opacity
  applyOverlayPassThrough()
}

/**
 * Handle an IP-exposed state change from broadcastIPStatus.
 * §8: an exposed IP overrides the operator's HUD preferences.
 */
export function handleIpExposedChange(exposed: boolean): void {
  if (exposed === overlayIpExposed) return
  overlayIpExposed = exposed
  if (exposed && overlayPassThrough) {
    overlayPassThrough = false
    applyOverlayPassThrough()
  } else {
    applyOverlayOpacity()
  }
}

export function isOverlayPassThrough(): boolean {
  return overlayPassThrough
}

export function registerOverlayIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  _ctx = ctx

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
  // setExpanded only toggles state now; the height comes from autosize.
  ipcMain.on('overlay:setExpanded', () => { /* height handled by overlay:autosize */ })
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
    ctx.send(ctx.getMainWindow(), 'overlay:visibilityChanged', false)
  })
  ipcMain.on('overlay:toggle', () => {
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide()
    } else {
      overlayWindow?.show()
    }
    ctx.send(ctx.getMainWindow(), 'overlay:visibilityChanged', overlayWindow?.isVisible() ?? false)
  })
  ipcMain.handle('overlay:isVisible', () => {
    return ctx.getOverlayWindow()?.isVisible() ?? false
  })
  ipcMain.on('overlay:mouseEnter', () => {
    if (overlayPassThrough) return
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = true
      overlayWindow.webContents.send('overlay:interactive', true)
    }
  })
  ipcMain.on('overlay:mouseLeave', () => {
    if (overlayPassThrough) return
    const overlayWindow = ctx.getOverlayWindow()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = false
      overlayWindow.webContents.send('overlay:interactive', false)
    }
  })

  // --- Quick mark / passthrough (overlay: prefix) ---
  ipcMain.on('overlay:quickMark', ctx.triggerBookmark)
  ipcMain.handle('overlay:instantMark', () => ctx.triggerInstantMark())
  // §8: the HUD action-row button turns pass-through ON (it can't turn it off —
  // once on, the HUD is click-through). The exits are ⌘⇧P and the menu bar.
  ipcMain.on('overlay:setPassThrough', (_e, on: boolean) => setOverlayPassThrough(!!on))
}
