import { Tray, Menu, nativeImage, BrowserWindow } from 'electron'

export function createTray(
  mainWindow: BrowserWindow,
  overlayWindow: BrowserWindow
): Tray {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARElEQVQ4T2P8z8Dwn4EIwMjAwMBIjAamfwwM/4nRz0C1F4hyAdVcQLQXiHYBVcOAaBeQHI2kuoDoaKRaQiI6JRDtAgCGHBAR1gFDqQAAAABJRU5ErkJggg=='
  )
  const tray = new Tray(icon.resize({ width: 16, height: 16 }))

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
