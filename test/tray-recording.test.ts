import { describe, it, expect, vi } from 'vitest'

const built: Array<Array<{ label?: string }>> = []
vi.mock('electron', () => {
  class Tray {
    setTitle(): void {}
    setImage(): void {}
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
  }
  const img = { isEmpty: () => false, setTemplateImage: () => {} }
  return {
    Tray,
    Menu: { buildFromTemplate: (items: Array<{ label?: string }>) => { built.push(items); return items } },
    nativeImage: { createFromPath: () => img, createFromDataURL: () => img },
    BrowserWindow: class {}
  }
})

import { createTray, setTrayRecording } from '../src/main/tray'

const labels = (): string[] => (built.at(-1) ?? []).map((item) => item.label ?? '')

describe('tray menu', () => {
  // The icon followed every pause and resume; the menu did not. It was built
  // once saying "Resume" and rebuilt only after a click on the tray item itself,
  // so a pause from the status bar, ⌘. or the palette left it wrong.
  it('says what the recording item will do after a toggle made elsewhere', () => {
    const win = { show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
    const tray = createTray(win as never, null, () => true)
    setTrayRecording(tray, true)
    expect(labels()).toContain('⏸ Pause Recording')
    setTrayRecording(tray, false)
    expect(labels()).toContain('⏺ Resume Recording')
  })

  // The item opens the marker dialog; the HUD's instant mark is the one that
  // files a marker without asking, and "Quick Mark" named that one.
  it('names the mark item after the dialog it opens', () => {
    const win = { show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
    createTray(win as never, null, undefined, () => {})
    expect(labels()).toContain('⚑ Add Marker…')
    expect(labels()).not.toContain('⚑ Quick Mark')
  })
})
