import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const shortcuts = vi.hoisted(() => ({ held: new Set<string>(), taken: false }))
vi.mock('electron', () => ({
  globalShortcut: {
    register: (acc: string) => { if (shortcuts.taken) return false; shortcuts.held.add(acc); return true },
    unregister: (acc: string) => { shortcuts.held.delete(acc) }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))

import {
  registerOverlayIpc, setOverlayPassThrough, bindOverlayReleaseShortcut, handleIpExposedChange,
  openHudPrefs, applyHudPrefs, hudPrefs, isOverlayPassThrough, stopOverlayMouseTracking, syncReleaseShortcut
} from '../src/main/ipc/overlay'
import { loadConfig, saveConfig } from '../src/core/config'
import { readHudPrefs } from '../src/main/services/hud-prefs'
import type { IpcContext } from '../src/main/ipc/types'

/** The stored setting: the machine-wide HUD prefs file, not the project. */
const storedPassThrough = (prefsDir: string): boolean => readHudPrefs(prefsDir).passThrough

describe('HUD pass-through', () => {
  let dir: string
  let prefsDir: string
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-passthrough-'))
    prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hudprefs-'))
    saveConfig(dir, loadConfig(dir))
    send = vi.fn()
    const ctx = {
      getActiveProject: () => ({ id: 'p1', name: 'p1', path: dir }),
      getMainWindow: () => null,
      getOverlayWindow: () => null,
      getCurrentEngagementId: () => null,
      getCurrentOperatorId: () => null,
      send,
      triggerBookmark: vi.fn(),
      addHudMarker: () => ({ ok: true })
    } as unknown as IpcContext
    registerOverlayIpc({ on: vi.fn(), handle: vi.fn() } as never, ctx, { prefsDir })
  })
  afterEach(() => {
    handleIpExposedChange(false)
    setOverlayPassThrough(false)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(prefsDir, { recursive: true, force: true })
  })

  // The HUD button, ⌘⇧P and the tray change pass-through at runtime, and every
  // project open re-applies the stored setting. A runtime change that is not
  // the setting is undone by the next open.
  it('releases and persists from a window key event when the global callback is not delivered', () => {
    const on = vi.fn()
    bindOverlayReleaseShortcut({ on } as never)
    const callback = on.mock.calls.find(([name]) => name === 'before-input-event')![1]
    const preventDefault = vi.fn()
    setOverlayPassThrough(true)
    const input = {
      type: 'keyDown', key: 'P', shift: true, alt: false,
      meta: process.platform === 'darwin', control: process.platform !== 'darwin'
    }
    callback({ preventDefault }, input)
    expect(storedPassThrough(prefsDir)).toBe(false)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    // Repeating the recovery key must never turn pass-through back on.
    callback({ preventDefault }, input)
    expect(storedPassThrough(prefsDir)).toBe(false)
  })

  it('does not consume typing, other modifiers or key-up', () => {
    const on = vi.fn()
    bindOverlayReleaseShortcut({ on } as never)
    const callback = on.mock.calls[0][1]
    const preventDefault = vi.fn()
    const input = {
      type: 'keyDown', key: 'P', shift: true, alt: false,
      meta: process.platform === 'darwin', control: process.platform !== 'darwin'
    }
    setOverlayPassThrough(true)
    for (const delta of [
      { shift: false }, { alt: true }, { type: 'keyUp' }, { key: 'x' },
      { meta: false, control: false }, { meta: true, control: true }
    ]) callback({ preventDefault }, { ...input, ...delta })
    expect(storedPassThrough(prefsDir)).toBe(true)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  // ⌘⇧P is VS Code's palette and Burp's Proxy tab. Held for the whole run it
  // was taken from both whether or not there was anything to release.
  it('does not hold the global release chord when there is no HUD window', () => {
    setOverlayPassThrough(true)
    expect(shortcuts.held.size).toBe(0)
  })

  it('stores a runtime toggle as the setting', () => {
    setOverlayPassThrough(true)
    expect(storedPassThrough(prefsDir)).toBe(true)
    setOverlayPassThrough(false)
    expect(storedPassThrough(prefsDir)).toBe(false)
  })

  it('stores the setting with the HUD prefs and leaves the project config alone', () => {
    const before = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')
    setOverlayPassThrough(true)
    expect(storedPassThrough(prefsDir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')).toBe(before)
  })

  // §8: an exposed IP turns click-through off for good and keeps it off.
  describe('while the external IP is exposed', () => {
    it('turns it off in the setting, not only in the window', () => {
      setOverlayPassThrough(true)
      handleIpExposedChange(true)
      expect(isOverlayPassThrough()).toBe(false)
      expect(storedPassThrough(prefsDir)).toBe(false)
    })

    it('refuses to turn it on from any entry, and answers with the real state', () => {
      handleIpExposedChange(true)
      send.mockClear()
      setOverlayPassThrough(true)
      expect(isOverlayPassThrough()).toBe(false)
      expect(storedPassThrough(prefsDir)).toBe(false)
      expect(send).toHaveBeenCalledWith(null, 'hudPrefs:changed', expect.objectContaining({ passThrough: false }))
    })

    it('refuses it through the Settings channel as well', () => {
      handleIpExposedChange(true)
      const handle = vi.fn()
      // the hudPrefs:set handler is what Settings ▸ HUD calls
      registerOverlayIpc({ on: vi.fn(), handle } as never, {
        getActiveProject: () => null, getMainWindow: () => null, getOverlayWindow: () => null, send: vi.fn()
      } as unknown as IpcContext, { prefsDir })
      const set = handle.mock.calls.find(([ch]) => ch === 'hudPrefs:set')![1]
      const writes = vi.spyOn(fs, 'writeFileSync')
      expect(set(null, { passThrough: true, scale: 1.25 })).toMatchObject({ passThrough: false, scale: 1.25 })
      expect(storedPassThrough(prefsDir)).toBe(false)
      // not even for a moment: "on" never reaches the file
      expect(writes.mock.calls.some(([, body]) => String(body).includes('"passThrough": true'))).toBe(false)
      writes.mockRestore()
    })

    // The edge the old per-project copy left: a project opened while exposed
    // with "on" stored ran with it off, so a later "off" compared against the
    // runtime value, saw nothing to do, and left "on" in the file.
    it('stores off a setting of "on" that arrives while exposed', () => {
      handleIpExposedChange(true)
      openHudPrefs({ passThrough: true }) // first project ever, old `overlay:` block
      expect(hudPrefs().passThrough).toBe(true)
      setOverlayPassThrough(false)
      expect(storedPassThrough(prefsDir)).toBe(false)
    })

    it('a project open while exposed does not bring it back', () => {
      handleIpExposedChange(true)
      openHudPrefs({ passThrough: true })
      applyHudPrefs()
      expect(isOverlayPassThrough()).toBe(false)
      expect(storedPassThrough(prefsDir)).toBe(false)
    })

    it('stays off when the address is safe again, until the operator turns it on', () => {
      setOverlayPassThrough(true)
      handleIpExposedChange(true)
      handleIpExposedChange(false)
      expect(isOverlayPassThrough()).toBe(false)
      setOverlayPassThrough(true)
      expect(isOverlayPassThrough()).toBe(true)
      expect(storedPassThrough(prefsDir)).toBe(true)
    })
  })
})

describe('HUD prefs are the operator\'s, not the project\'s', () => {
  let prefsDir: string
  let send: ReturnType<typeof vi.fn>
  let hud: {
    visible: boolean
    isDestroyed: () => boolean
    isVisible: () => boolean
    showInactive: ReturnType<typeof vi.fn>
    setOpacity: ReturnType<typeof vi.fn>
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>
    getBounds: () => { x: number; y: number; width: number; height: number }
    webContents: { send: ReturnType<typeof vi.fn> }
  }
  let applied: ReturnType<typeof vi.fn>

  beforeEach(() => {
    prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hudprefs-'))
    send = vi.fn()
    applied = vi.fn()
    shortcuts.taken = false
    hud = {
      visible: false,
      isDestroyed: () => false,
      isVisible: () => hud.visible,
      showInactive: vi.fn(() => { hud.visible = true }),
      setOpacity: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 440, height: 80 }),
      webContents: { send: vi.fn() }
    }
    const ctx = {
      getActiveProject: () => null,
      getMainWindow: () => null,
      getOverlayWindow: () => hud,
      getCurrentEngagementId: () => null,
      getCurrentOperatorId: () => null,
      send,
      triggerBookmark: vi.fn(),
      addHudMarker: () => ({ ok: true })
    } as unknown as IpcContext
    registerOverlayIpc({ on: vi.fn(), handle: vi.fn() } as never, ctx, { prefsDir, onPrefsApplied: applied })
  })
  afterEach(() => {
    handleIpExposedChange(false)
    setOverlayPassThrough(false)
    stopOverlayMouseTracking()
    shortcuts.taken = false
    fs.rmSync(prefsDir, { recursive: true, force: true })
  })

  // ⌘⇧P is VS Code's palette and Burp's Proxy tab: held only while there is a
  // visible HUD that is click-through. After a project closes the HUD is hidden
  // and the chord must go back to the other applications.
  it('holds the global release chord only while pass-through is on and the HUD is visible', () => {
    const chord = ['CommandOrControl+Shift+P']
    hud.visible = false
    setOverlayPassThrough(true)
    expect(shortcuts.held.size).toBe(0) // on, but the HUD is hidden
    hud.visible = true
    syncReleaseShortcut() // what the window's show event does
    expect([...shortcuts.held]).toEqual(chord)
    hud.visible = false
    syncReleaseShortcut() // its hide event
    expect(shortcuts.held.size).toBe(0)
    hud.visible = true
    syncReleaseShortcut()
    setOverlayPassThrough(false)
    expect(shortcuts.held.size).toBe(0) // visible, but nothing to release
  })

  it('gives the chord back on exposure, and does not take it again when the exposure ends', () => {
    hud.visible = true
    setOverlayPassThrough(true)
    expect(shortcuts.held.size).toBe(1)
    handleIpExposedChange(true)
    expect(shortcuts.held.size).toBe(0)
    handleIpExposedChange(false)
    expect(shortcuts.held.size).toBe(0)
  })

  it('says so when another application holds the chord, and tries again next time', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    shortcuts.taken = true
    hud.visible = true
    setOverlayPassThrough(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taken by another application'))
    shortcuts.taken = false
    syncReleaseShortcut()
    expect(shortcuts.held.size).toBe(1)
    warn.mockRestore()
  })

  it('seeds once from the first project opened, and a second project does not change them', () => {
    expect(fs.existsSync(path.join(prefsDir, 'hud-prefs.json'))).toBe(false)
    const first = openHudPrefs({ scale: 1.5, showMarkButton: false, autoShow: false, passThroughOpacity: 0.6 })
    expect(first).toMatchObject({ scale: 1.5, showMarkButton: false, autoShow: false, passThroughOpacity: 0.6 })
    const second = openHudPrefs({ scale: 0.75, showMarkButton: true, autoShow: true, passThroughOpacity: 0.2 })
    expect(second).toEqual(first)
    expect(readHudPrefs(prefsDir)).toEqual(first)
  })

  it('takes the defaults when the first project has no overlay block, and ignores junk', () => {
    expect(openHudPrefs(undefined)).toMatchObject({ autoShow: true, scale: 1, passThrough: false })
    fs.rmSync(path.join(prefsDir, 'hud-prefs.json'))
    expect(openHudPrefs({ scale: 'huge', passThrough: 'yes', passThroughOpacity: 7 }))
      .toMatchObject({ scale: 1, passThrough: false, passThroughOpacity: 0.4 })
  })

  it('writes the file owner-only and reads a broken one as the defaults', () => {
    openHudPrefs({ scale: 1.25 })
    const file = path.join(prefsDir, 'hud-prefs.json')
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    fs.writeFileSync(file, '{ truncated')
    expect(readHudPrefs(prefsDir)).toMatchObject({ scale: 1, autoShow: true })
  })

  it('pushes every setting to the HUD window and hands the rest to main on apply', () => {
    openHudPrefs({ showMarkButton: false, flashOnExposed: false, scale: 1.25, emphasizeExternalIp: true, showInDock: false })
    send.mockClear()
    applyHudPrefs()
    const pushed = Object.fromEntries(send.mock.calls.filter(([w]) => w === hud).map(([, ch, ...rest]) => [ch, rest]))
    expect(pushed['overlay:showMark']).toEqual([false])
    expect(pushed['overlay:flashExposed']).toEqual([false])
    expect(pushed['overlay:scale']).toEqual([1.25])
    expect(pushed['overlay:emphasizeIp']).toEqual([true])
    expect(pushed['overlay:passThrough']).toEqual([false, 0.4])
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ showInDock: false }))
  })

  it('announces a change so Settings mirrors the HUD button, ⌘⇧P and the menu bar', () => {
    openHudPrefs(undefined)
    setOverlayPassThrough(true)
    expect(send).toHaveBeenCalledWith(null, 'hudPrefs:changed', expect.objectContaining({ passThrough: true }))
    expect(hudPrefs().passThrough).toBe(true)
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ passThrough: true }))
  })

  // §8: the exposure alarm was only an opacity change, so a HUD the operator
  // had closed, or never had open, said nothing while their address was out.
  it('shows a hidden HUD, without focus, when the IP becomes exposed, and leaves it shown', () => {
    openHudPrefs({ autoShow: false })
    handleIpExposedChange(true)
    expect(hud.showInactive).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(null, 'overlay:visibilityChanged', true)
    handleIpExposedChange(false)
    expect(hud.visible).toBe(true)
  })

  it('does not re-show on every exposed tick, only on the change', () => {
    handleIpExposedChange(true)
    hud.visible = false // the operator closes it during the exposure
    handleIpExposedChange(true)
    expect(hud.showInactive).toHaveBeenCalledTimes(1)
  })
})
