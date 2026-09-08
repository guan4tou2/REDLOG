import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { attachContextMenu } from './context-menu'
import { defaultOverlayBounds } from '../core/overlay-layout'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// The app is a local SPA: it never opens sub-windows and never navigates away
// from its own content (external links go through the app:openExternal IPC,
// which is http/https-allowlisted). So deny every window-open and every
// navigation to a foreign origin. Without this, a captured link inside evidence
// data (an HTTP body, an agent transcript) could load attacker content
// in-window; with no CSP that would be unconstrained. Applied to both windows.
function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const ok = url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl))
    if (!ok) e.preventDefault()
  })
}

export function createMainWindow(savedBounds?: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    // Default sized to the dashboard's "寬屏 1400px 居中" layout (§22) so the
    // one-screen-one-question view shows at full width on first launch, with
    // more vertical room for the timeline and the HTTP/loot tables. A saved
    // bound (the operator resized) always wins.
    width: savedBounds?.width ?? 1400,
    height: savedBounds?.height ?? 900,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 500,
    show: false,
    // Windows wants an .ico here: it picks the 16px representation for the title
    // bar and the 32px one for the taskbar, and a single 256px PNG has to be
    // downscaled into both — which is where a thin ring stops being a ring.
    // macOS ignores this field entirely; Linux wants the PNG.
    icon: join(__dirname, '../../resources', isWin ? 'icon.ico' : 'icon-256.png'),
    backgroundColor: '#121214',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: '#121214',
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

  // Right-click gets a native menu (copy/paste in fields, copy for a plain
  // selection). Without this the app has no context menu at all, which is one
  // of the loudest "this is a web page" tells on the desktop.
  attachContextMenu(win.webContents, { dev: is.dev })
  hardenNavigation(win)

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

export function createOverlayWindow(saved?: { x: number; y: number } | null): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = 440
  const placed = saved ?? defaultOverlayBounds(workArea, width)

  const win = new BrowserWindow({
    width,
    height: 52,
    x: placed.x,
    y: placed.y,
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
  hardenNavigation(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  return win
}
