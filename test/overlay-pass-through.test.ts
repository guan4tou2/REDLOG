import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))

import { registerOverlayIpc, setOverlayPassThrough, bindOverlayReleaseShortcut } from '../src/main/ipc/overlay'
import { loadConfig, saveConfig } from '../src/core/config'
import type { IpcContext } from '../src/main/ipc/types'

describe('HUD pass-through', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-passthrough-'))
    saveConfig(dir, loadConfig(dir))
    const ctx = {
      getActiveProject: () => ({ id: 'p1', name: 'p1', path: dir }),
      getMainWindow: () => null,
      getOverlayWindow: () => null,
      getCurrentEngagementId: () => null,
      getCurrentOperatorId: () => null,
      send: vi.fn(),
      triggerBookmark: vi.fn(),
      addHudMarker: () => ({ ok: true })
    } as unknown as IpcContext
    registerOverlayIpc({ on: vi.fn(), handle: vi.fn() } as never, ctx)
  })
  afterEach(() => {
    setOverlayPassThrough(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // The HUD button, ⌘⇧P and the tray change pass-through at runtime, and every
  // config save re-applies the stored setting. A runtime change that is not the
  // setting is undone by the next unrelated Settings autosave.
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
    expect(loadConfig(dir).overlay?.passThrough).toBe(false)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    // Repeating the recovery key must never turn pass-through back on.
    callback({ preventDefault }, input)
    expect(loadConfig(dir).overlay?.passThrough).toBe(false)
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
    expect(loadConfig(dir).overlay?.passThrough).toBe(true)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('stores a runtime toggle as the setting', () => {
    setOverlayPassThrough(true)
    expect(loadConfig(dir).overlay?.passThrough).toBe(true)
    setOverlayPassThrough(false)
    expect(loadConfig(dir).overlay?.passThrough).toBe(false)
  })
})
