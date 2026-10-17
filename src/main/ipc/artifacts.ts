// Operator-added local artifacts (#221). Only a file the operator chose is
// read: either picked in the main process's own file dialog, or dropped on
// the window — and a drop is confirmed in a main-process dialog listing the
// files before anything is copied, so a path handed in by the renderer is
// never read on the renderer's word alone.

import path from 'path'
import { dialog, shell, type IpcMain } from 'electron'
import { resolveEvidenceFile } from '../../core/evidence-file'
import type { IpcContext } from './types'
import type { ProjectMeta } from '../../core/project-manager'
import { ingestEvent } from '../../core/ingest'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig } from '../../core/config'
import { queryEvents } from '../../core/db/event-queries'
import { addArtifact, artifactRelatedCommands, type ArtifactAddOutcome, type ArtifactAddResponse } from '../../core/artifacts'

const RELATED_WINDOW_MS = 24 * 60 * 60 * 1000
/** A drop larger than this is almost certainly a mistake, not evidence. */
const MAX_DROPPED = 50

function addFiles(proj: ProjectMeta, files: string[]): ArtifactAddOutcome[] {
  const projectDir = getProjectDir(proj)
  const config = loadConfig(projectDir)
  const results: ArtifactAddOutcome[] = []
  for (const file of files) {
    const r = addArtifact(projectDir, file)
    if (!r.ok) { results.push(r); continue }
    let related: ReturnType<typeof artifactRelatedCommands> = []
    try {
      related = artifactRelatedCommands(r.originalPath, r.mtime, queryEvents({
        agentType: 'shell', since: r.mtime - RELATED_WINDOW_MS, before: r.mtime + RELATED_WINDOW_MS, limit: 5000
      }))
    } catch { /* a hint only; the artifact is still recorded */ }
    const ev = ingestEvent('file_transfer', {
      subtype: 'artifact_added',
      source: 'operator',
      path: r.originalPath,
      stored: r.stored,
      sha256: r.sha256,
      size: r.bytes,
      mtime: r.mtime,
      ...(r.duplicate ? { duplicate: true } : {}),
      ...(related.length > 0 ? { related_commands: related } : {})
    }, { engagementId: config.engagement.id, operatorId: config.operator.id, bypassPause: true })
    results.push({ ...r, eventId: ev?.id ?? null, relatedCommands: related.length })
  }
  return results
}

const label = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.slice(0, 200) : fallback

export function registerArtifactsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  // Show an evidence file in the file manager. Reveal, never open: the file may
  // be a sample the operator was handed, and opening runs it with whatever the
  // OS associates. Only a file inside this project's artifacts/ or screenshots/
  // resolves; the renderer names it, it does not choose the location.
  ipcMain.handle('artifacts:reveal', (_e, kind: unknown, file: unknown): boolean => {
    const proj = ctx.getActiveProject()
    if (!proj || (kind !== 'artifact' && kind !== 'screenshot')) return false
    const resolved = resolveEvidenceFile(getProjectDir(proj), kind, file)
    if (!resolved) return false
    shell.showItemInFolder(resolved)
    return true
  })

  ipcMain.handle('artifacts:add', async (_e, title?: unknown): Promise<ArtifactAddResponse | null> => {
    const proj = ctx.getActiveProject()
    const win = ctx.getMainWindow()
    if (!proj || !win) return null
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      // The renderer passes the title in the operator's language.
      title: label(title, 'Add evidence files')
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true, results: [] }
    // The project may have closed while the picker was open.
    if (ctx.getActiveProject()?.id !== proj.id) return null
    return { canceled: false, results: addFiles(proj, picked.filePaths) }
  })

  // Files dropped on the window (UI/UX audit F8). The confirmation is shown by
  // the main process, naming every file, and nothing is read until the
  // operator agrees there.
  ipcMain.handle('artifacts:addDropped', async (
    _e, paths: unknown, text?: { title?: unknown; message?: unknown; confirm?: unknown; cancel?: unknown }
  ): Promise<ArtifactAddResponse | null> => {
    const proj = ctx.getActiveProject()
    const win = ctx.getMainWindow()
    if (!proj || !win) return null
    const files = Array.isArray(paths)
      ? [...new Set(paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)))].slice(0, MAX_DROPPED)
      : []
    if (files.length === 0) return { canceled: true, results: [] }
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      title: label(text?.title, 'Add evidence files'),
      message: label(text?.message, `Add ${files.length} file(s) to this project as evidence?`),
      detail: files.join('\n'),
      buttons: [label(text?.confirm, 'Add'), label(text?.cancel, 'Cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response !== 0) return { canceled: true, results: [] }
    if (ctx.getActiveProject()?.id !== proj.id) return null
    return { canceled: false, results: addFiles(proj, files) }
  })
}
