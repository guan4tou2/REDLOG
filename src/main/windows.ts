import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

export function createMainWindow(savedBounds?: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    width: savedBounds?.width ?? 1100,
    height: savedBounds?.height ?? 700,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 500,
    show: false,
    icon: join(__dirname, '../../resources/icon-256.png'),
    backgroundColor: '#0a0a0a',
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
    if (isWin) {
      const dpi = screen.getPrimaryDisplay().scaleFactor
      if (dpi <= 1) win.webContents.setZoomFactor(1.1)
    }
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
    movable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setIgnoreMouseEvents(true, { forward: true })
  // 'screen-saver' is the highest window level — the HUD stays above other
  // always-on-top windows (and over fullscreen apps, via visibleOnFullScreen).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  return win
}
