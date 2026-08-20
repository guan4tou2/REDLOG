import { BrowserWindow, Menu, type IpcMain, type MenuItemConstructorOptions, type WebContents } from 'electron'

// Native right-click menus. A desktop app without them reads as "a web page in
// a window" — you can select an IP in the Timeline and then have nowhere to
// click Copy. Two mechanisms, because the two cases need different knowledge:
//
//   1. Chromium's own `context-menu` event covers editable fields and plain
//      selected text. It arrives with `editFlags` already computed, and the
//      standard menu *roles* are localised by the OS, so nothing here goes
//      through the renderer's i18n table.
//   2. xterm draws its own selection (the DOM never has one), so a terminal
//      right-click reports isEditable:false + selectionText:'' and case 1
//      correctly produces nothing. TerminalView asks for its menu explicitly
//      over `ui:contextMenu` instead — see sanitizeRendererMenu.

/** The subset of Electron's context-menu params the template keys off. */
export interface ContextMenuInput {
  isEditable: boolean
  selectionText: string
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

/**
 * Standard menu for a right-click. Empty means "no menu" — showing an empty
 * popup (or a menu whose every item is greyed out) is worse than showing none,
 * and an empty return is what lets the terminal own its own right-click.
 */
export function buildContextMenuTemplate(p: ContextMenuInput): MenuItemConstructorOptions[] {
  if (p.isEditable) {
    return [
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll }
    ]
  }
  if (p.selectionText.trim()) return [{ role: 'copy' }]
  return []
}

export function attachContextMenu(wc: WebContents, opts: { dev?: boolean } = {}): void {
  wc.on('context-menu', (_e, params) => {
    const template = buildContextMenuTemplate(params)
    if (opts.dev) {
      if (template.length) template.push({ type: 'separator' })
      const { x, y } = params
      template.push({ label: 'Inspect Element', click: () => wc.inspectElement(x, y) })
    }
    if (!template.length) return
    const win = BrowserWindow.fromWebContents(wc)
    Menu.buildFromTemplate(template).popup(win ? { window: win } : undefined)
  })
}

/** One entry of a renderer-requested menu. `id` comes back as the result. */
export interface RendererMenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'separator'
}

const MAX_ITEMS = 16
const MAX_LABEL = 64
const MAX_ID = 32

/**
 * The renderer names menu entries, so treat the payload as untrusted input:
 * labels are plain strings with no click handler attached on that side, ids are
 * bounded, and anything malformed is dropped rather than rendered. Separators
 * are trimmed at the ends and never doubled up, so a caller that conditionally
 * omits an item can't leave a stray rule floating at the top of the menu.
 */
export function sanitizeRendererMenu(items: unknown): RendererMenuItem[] {
  if (!Array.isArray(items)) return []
  const out: RendererMenuItem[] = []
  for (const raw of items.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as RendererMenuItem
    if (item.type === 'separator') {
      // No leading separator, no two in a row.
      if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' })
      continue
    }
    const { id, label } = item
    if (typeof id !== 'string' || !id || id.length > MAX_ID) continue
    if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL) continue
    out.push({ id, label, enabled: item.enabled !== false })
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

export function registerContextMenuIpc(ipcMain: IpcMain): void {
  ipcMain.handle('ui:contextMenu', (e, items: unknown) => {
    const clean = sanitizeRendererMenu(items)
    if (!clean.length) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate(
        clean.map((i) =>
          i.type === 'separator'
            ? { type: 'separator' as const }
            : { label: i.label, enabled: i.enabled, click: () => { picked = i.id ?? null } }
        )
      )
      const win = BrowserWindow.fromWebContents(e.sender)
      // `callback` fires after the menu closes — including a dismissal, which
      // resolves null so the renderer's await always settles.
      menu.popup({ ...(win ? { window: win } : {}), callback: () => resolve(picked) })
    })
  })
}
