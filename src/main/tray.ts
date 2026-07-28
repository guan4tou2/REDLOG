import { Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'

export function createTray(
  mainWindow: BrowserWindow,
  overlayWindow: BrowserWindow | null
): Tray {
  const trayIconPath = join(__dirname, '../../resources/tray-iconTemplate.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  icon.setTemplateImage(true)
  const tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show RedLog',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      }
    },
    {
      label: 'Toggle IP Overlay',
      click: () => {
        if (!overlayWindow) return
        if (overlayWindow.isVisible()) {
          overlayWindow.hide()
        } else {
          overlayWindow.show()
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ])

  tray.setToolTip('RedLog')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  return tray
}
