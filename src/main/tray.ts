import { Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

const basePath = join(__dirname, '../../resources')

function loadIcon(names: string[]): Electron.NativeImage {
  for (const name of names) {
    const p = join(basePath, name)
    if (existsSync(p)) {
      try {
        const buf = readFileSync(p)
        const img = nativeImage.createFromBuffer(buf)
        if (!img.isEmpty()) return img
      } catch {}
    }
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAh0lEQVR4nO2UUQrAIAxD3dgFdieP7Z08wvY1EMHR2JQxTH7V+mjTpCStrm10UHO+PIXPUoa1W+2eTxgSwGG9aJ3po9ZDb28/74AAzB5A9ZscUBIKwJ2EvVfQxHR3oP8QNS9lBB4ImgdmIagmnIGgbwEKEbKGCERYDlghQoPIAhGehGgwSevpBgrkNl2U/9ihAAAAAElFTkSuQmCC'
  )
}

let templateIcon: Electron.NativeImage | null = null
let recIcon: Electron.NativeImage | null = null
let pausedIcon: Electron.NativeImage | null = null

function getTemplateIcon(): Electron.NativeImage {
  if (!templateIcon) {
    templateIcon = loadIcon(['tray-iconTemplate@2x.png', 'tray-iconTemplate.png'])
    templateIcon.setTemplateImage(true)
  }
  return templateIcon
}

function getRecIcon(): Electron.NativeImage {
  if (!recIcon) {
    recIcon = loadIcon(['tray-icon-rec@2x.png', 'tray-icon-rec.png'])
    recIcon.setTemplateImage(false)
  }
  return recIcon
}

function getPausedIcon(): Electron.NativeImage {
  if (!pausedIcon) {
    pausedIcon = loadIcon(['tray-icon-paused@2x.png', 'tray-icon-paused.png'])
    pausedIcon.setTemplateImage(false)
  }
  return pausedIcon
}

export function setTrayRecording(tray: Tray, recording: boolean | null): void {
  if (recording === null) {
    tray.setImage(getTemplateIcon())
    tray.setTitle('')
    tray.setToolTip('RedLog — Red Team Operation Log')
    return
  }
  if (recording) {
    tray.setImage(getRecIcon())
    tray.setTitle(' REC', { fontType: 'monospacedDigit' })
    tray.setToolTip('RedLog — Recording')
  } else {
    tray.setImage(getPausedIcon())
    tray.setTitle(' PAUSED', { fontType: 'monospacedDigit' })
    tray.setToolTip('RedLog — Paused')
  }
}

export function createTray(
  mainWindow: BrowserWindow,
  overlayWindow: BrowserWindow | null,
  onToggleRecording?: () => boolean
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
      label: 'Toggle IP Overlay',
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
