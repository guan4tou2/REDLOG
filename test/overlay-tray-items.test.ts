import { describe, it, expect, vi } from 'vitest'

// The tray's HUD items. Before the first project there is no HUD window, and
// "Toggle HUD" was an item that did nothing; "Release HUD click-through" was
// offered with nothing to release.

const built: Array<Array<{ label?: string; enabled?: boolean }>> = []
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

import { createTray, refreshTrayMenu, setTrayRecording } from '../src/main/tray'

const item = (label: string): { enabled?: boolean } | undefined => (built.at(-1) ?? []).find((i) => i.label === label)
const win = { show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }

describe('tray HUD items', () => {
  it('disables Toggle HUD until a HUD window exists, and enables it on refresh', () => {
    let hud: unknown = null
    const tray = createTray(win as never, () => hud as never, () => true, () => {}, () => {}, () => false)
    expect(item('Toggle HUD')?.enabled).toBe(false)
    hud = { isDestroyed: () => false, isVisible: () => false, show: vi.fn(), hide: vi.fn() }
    refreshTrayMenu(tray)
    expect(item('Toggle HUD')?.enabled).toBe(true)
  })

  // After a project closes the menu goes back to the no-project state
  // (setTrayRecording(tray, null)); there is nothing to pause or resume.
  it('disables Pause/Resume while no project is open', () => {
    const tray = createTray(win as never, () => null, () => true, () => {}, () => {}, () => false)
    expect(item('⏺ Resume Recording')?.enabled).toBe(false)
    setTrayRecording(tray, true)
    expect(item('⏸ Pause Recording')?.enabled).toBe(true)
    setTrayRecording(tray, false)
    expect(item('⏺ Resume Recording')?.enabled).toBe(true)
    setTrayRecording(tray, null)
    expect(item('⏺ Resume Recording')?.enabled).toBe(false)
  })

  it('offers the click-through release only while pass-through is on', () => {
    let on = false
    const tray = createTray(win as never, () => null, () => true, () => {}, () => {}, () => on)
    expect(item('Release HUD Click-through')?.enabled).toBe(false)
    on = true
    refreshTrayMenu(tray)
    expect(item('Release HUD Click-through')?.enabled).toBe(true)
  })
})
