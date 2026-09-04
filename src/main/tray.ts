import { Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { QUICK_MARK_ACCELERATOR } from '../core/shortcuts'

const basePath = join(__dirname, '../../resources')

// Load by PATH, not by buffer. `createFromPath` is the one that looks beside the
// file for its `@2x` neighbour and builds a proper HiDPI image; a buffer has no
// filename to look beside. The old code handed the 32px Retina asset straight to
// `createFromBuffer`, which has no way to know it is a 2x asset, so it became a
// 32-POINT image that macOS then squeezed into a 22pt menu bar.
function loadIcon(name: string): Electron.NativeImage {
  const p = join(basePath, name)
  if (existsSync(p)) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    } catch {}
  }
  // Last resort when resources/ is not on disk at all. Regenerate it by running
  // tools/make-icons.py, which prints this exact string.
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAB1ElEQVRYhe2Wv04CQRDGf0IprYXCGa1MwJfwT4nyHKKgxsbXsESt7CQkxoIYC1+CUGihFvinQgM0XlCx2DvBueNu96SDL9lib+eb+W53ZnZhgnHHlKG9BeSALLAApJzvT8AjUAUugcaI9P0iCZSALtALGV9A2RE4EuSAjkZgOdrA5n+D76L+yDT44G4UowbPDQlec5ymgWlnZByxtSEijHciiXfbP4A8EAvgxRwbW3BbwJyJgFPhwAZWDPirPiKOdckW8CnIWwbBXewIH13UzhoTa3i33QIqqExvAxfAkrCJA3XhK68j4EqQZBZbQBNvsr05a4PYEzZVHQF3gpQW6xWf4O4oC9uMWL/VESCzPyHW2wECWsI2IdY7MlhQSUVBL8T/t46AFzGfF/ObAAHXIdxXHQEPYr4u5ofAuw+vCRyEcO99eB74lWFc2FiohGs545z+1ewichn6NaJtHaJAQfjQbkQAJ4Jso9qrLtbwtuKSAZ8k3nKzUccjj2MQcdSf+11GsyYCQF2hftdxHdXhMqg6TwDLwD7eM3ev46xpcBfFISJMHiSFqMFdbBDc/YK6YuQ/l5gBjtB/lJ6heeamz/IUKjeywCL92m/w91n+bOh3gjHGD+raBT3FXjKEAAAAAElFTkSuQmCC'
  )
}

// setTemplateImage is a macOS-only API: on Windows and Linux it does nothing,
// so a black-plus-alpha glyph stays black and disappears into a dark taskbar.
// Those platforms get the mark's own colour instead, which reads against a dark
// taskbar and a light one alike.
const TEMPLATED = process.platform === 'darwin'

let templateIcon: Electron.NativeImage | null = null
let recIcon: Electron.NativeImage | null = null
let pausedIcon: Electron.NativeImage | null = null

function getTemplateIcon(): Electron.NativeImage {
  if (!templateIcon) {
    templateIcon = loadIcon(TEMPLATED ? 'tray-iconTemplate.png' : 'tray-icon-idle.png')
    templateIcon.setTemplateImage(TEMPLATED)
  }
  return templateIcon
}

function getRecIcon(): Electron.NativeImage {
  if (!recIcon) {
    recIcon = loadIcon('tray-icon-rec.png')
    recIcon.setTemplateImage(false)
  }
  return recIcon
}

function getPausedIcon(): Electron.NativeImage {
  if (!pausedIcon) {
    // Paused is the same glyph at 45% alpha. On macOS it stays a template, so
    // the dimming reads on a light menu bar too — the previous fixed zinc grey
    // was a pale smudge against white and only ever looked right in dark mode.
    pausedIcon = loadIcon(TEMPLATED ? 'tray-icon-paused.png' : 'tray-icon-idle-dim.png')
    pausedIcon.setTemplateImage(TEMPLATED)
  }
  return pausedIcon
}

// Blink the recording icon in place of a text title — a pulsing red dot reads at
// a glance and doesn't eat menu-bar width the way " REC" does.
let blinkTimer: ReturnType<typeof setInterval> | null = null
function stopBlink(): void {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null }
}

export function setTrayRecording(tray: Tray, recording: boolean | null): void {
  stopBlink()
  tray.setTitle('') // no text label — keep the menu bar compact
  if (recording === null) {
    tray.setImage(getTemplateIcon())
    tray.setToolTip('RedLog — Red Team Operation Log')
    return
  }
  if (recording) {
    tray.setToolTip('RedLog — Recording')
    let on = true
    tray.setImage(getRecIcon())
    blinkTimer = setInterval(() => {
      on = !on
      try { tray.setImage(on ? getRecIcon() : getTemplateIcon()) } catch { stopBlink() }
    }, 750)
  } else {
    tray.setImage(getPausedIcon())
    tray.setToolTip('RedLog — Paused')
  }
}

export function createTray(
  mainWindow: BrowserWindow,
  overlayWindow: BrowserWindow | null,
  onToggleRecording?: () => boolean,
  onQuickMark?: () => void
): Tray {
  const tray = new Tray(getTemplateIcon())

  const buildMenu = (recording?: boolean): void => {
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Show RedLog',
        click: () => {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    ]

    if (onQuickMark) {
      items.push({
        label: '⚑ Quick Mark',
        accelerator: QUICK_MARK_ACCELERATOR,
        click: () => onQuickMark()
      })
    }

    if (onToggleRecording) {
      items.push({
        label: recording ? '⏸ Pause Recording' : '⏺ Resume Recording',
        click: () => {
          const newState = onToggleRecording()
          setTrayRecording(tray, newState)
          buildMenu(newState)
        }
      })
    }

    items.push({
      label: 'Toggle HUD',
      click: () => {
        if (!overlayWindow) return
        if (overlayWindow.isVisible()) {
          overlayWindow.hide()
        } else {
          overlayWindow.show()
        }
        mainWindow.webContents.send('overlay:visibilityChanged', overlayWindow.isVisible())
      }
    })

    items.push({ type: 'separator' })
    items.push({ label: 'Quit', role: 'quit' })

    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  buildMenu()
  tray.on('click', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  return tray
}
