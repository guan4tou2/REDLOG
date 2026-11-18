import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  globalShortcut: { register: () => true, unregister: () => {} },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))

import { registerOverlayIpc, stopOverlayMouseTracking } from '../src/main/ipc/overlay'
import { readHudPrefs } from '../src/main/services/hud-prefs'
import type { IpcContext } from '../src/main/ipc/types'

// Settings ▸ HUD saves through `hudPrefs:set`. A failed write of the prefs
// file was logged and the handler answered as if it had been stored, so the
// page could not say anything: the change held until the next launch and
// then was gone. The handler now refuses, and a retry of the same value
// writes again instead of seeing "nothing changed" and answering success.
describe('hudPrefs:set when the prefs file cannot be written', () => {
  let prefsDir: string
  let set: (e: unknown, partial: unknown) => unknown

  beforeEach(() => {
    prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hudprefs-store-'))
    const handle = vi.fn()
    registerOverlayIpc({ on: vi.fn(), handle } as never, {
      getActiveProject: () => null, getMainWindow: () => null, getOverlayWindow: () => null, send: vi.fn()
    } as unknown as IpcContext, { prefsDir })
    set = handle.mock.calls.find(([ch]) => ch === 'hudPrefs:set')![1]
  })
  afterEach(() => {
    vi.restoreAllMocks()
    stopOverlayMouseTracking()
    fs.rmSync(prefsDir, { recursive: true, force: true })
  })

  it('refuses when the write fails, and stores the same value on retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => set(null, { scale: 1.25 })).toThrow()
    write.mockRestore()
    expect(set(null, { scale: 1.25 })).toMatchObject({ scale: 1.25 })
    expect(readHudPrefs(prefsDir).scale).toBe(1.25)
  })

  it('still answers with the prefs when the write succeeds', () => {
    expect(set(null, { scale: 1.5 })).toMatchObject({ scale: 1.5 })
    expect(readHudPrefs(prefsDir).scale).toBe(1.5)
  })
})
