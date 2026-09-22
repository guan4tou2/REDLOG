import { clipboard, type IpcMain } from 'electron'

// The renderer cannot use `navigator.clipboard`: main/index.ts installs a
// permission handler that grants geolocation and nothing else, and Chromium
// routes `clipboard-sanitized-write` / `clipboard-read` through it. Every
// in-app Copy button therefore rejected — silently, because the call sites
// dropped the promise. Main-process `clipboard` has no permission gate and no
// document-focus requirement, so copy works from a settings panel the same as
// from the Timeline.
//
// These are user-gesture writes, not capture. clipboard-monitor still samples
// the clipboard on its own poll, so an operator-initiated copy is recorded as
// clipboard activity when that capture source is enabled — which is what it
// observed, and suppressing our own writes would make the monitor lie about
// the clipboard state it saw.
export function registerClipboardIpc(ipcMain: IpcMain): void {
  ipcMain.handle('clipboard:writeText', (_e, text: unknown) => {
    if (typeof text !== 'string') return false
    try {
      clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('clipboard:readText', () => {
    try {
      return clipboard.readText()
    } catch {
      return ''
    }
  })
}
