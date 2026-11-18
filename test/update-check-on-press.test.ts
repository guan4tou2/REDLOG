import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

// Ruling 7: the update check runs only when the operator presses "Check for
// updates". With no launch check there is no "silent" check any more, so the
// one the button asks for is never skipped for being an unpackaged build —
// it used to be, for every caller that did not say `manual: true`.

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

afterEach(() => { vi.unstubAllGlobals() })

describe('the update check', () => {
  it('asks the release server when called, packaged or not', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => { asked.push(String(url)); return new Response('{}', { status: 404 }) })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const { checkForUpdates } = await import('../src/main/services/updater')
      await checkForUpdates()
    } finally { Object.defineProperty(process, 'platform', platform) }
    expect(asked.some((u) => u.includes('api.github.com'))).toBe(true)
  })
})
