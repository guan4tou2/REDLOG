import fs from 'fs'
import path from 'path'
import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getProjectDir } from '../../core/project-manager'

export function registerViewsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  const viewsFile = (): string | null => {
    const proj = ctx.getActiveProject()
    if (!proj) return null
    return path.join(getProjectDir(proj), 'views.json')
  }
  const readViews = (): Array<Record<string, unknown>> => {
    const p = viewsFile()
    if (!p || !fs.existsSync(p)) return []
    try { const arr = JSON.parse(fs.readFileSync(p, 'utf-8')); return Array.isArray(arr) ? arr : [] } catch { return [] }
  }
  const writeViews = (views: Array<Record<string, unknown>>): void => {
    const p = viewsFile()
    if (!p) return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(views, null, 2) + '\n', 'utf-8')
  }

  ipcMain.handle('views:list', () => readViews())

  ipcMain.handle('views:save', (_e, data: { name: string; state: Record<string, unknown> }) => {
    const list = readViews()
    const id = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const entry = {
      id,
      name: (data.name || 'Untitled').toString().slice(0, 120),
      createdAt: Date.now(),
      state: data.state ?? {}
    }
    list.unshift(entry)
    if (list.length > 100) list.length = 100
    writeViews(list)
    return entry
  })

  ipcMain.handle('views:delete', (_e, id: string) => {
    const list = readViews()
    const next = list.filter((v) => v.id !== id)
    if (next.length === list.length) return false
    writeViews(next)
    return true
  })
}
