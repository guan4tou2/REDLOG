import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const isMac = process.platform === 'darwin'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#0a0a0a',
    // macOS uses the inset traffic-light layout; Windows/Linux use a hidden
    // title bar with a native window-controls overlay so min/max/close remain
    // usable behind our custom drag region.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: '#0a0a0a',
            symbolColor: '#a1a1aa',
            height: 40
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function createOverlayWindow(): BrowserWindow {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 440,
    height: 52,
    x: screenW - 440,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setIgnoreMouseEvents(false)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  return win
}
