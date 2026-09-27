// Operator-added local artifacts (#221). The renderer never hands a path in:
// the main process opens the file picker itself, so only a file the operator
// picked is ever read.

import { dialog, type IpcMain } from 'electron'
import type { IpcContext } from './types'
import { ingestEvent } from '../../core/ingest'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig } from '../../core/config'
import { queryEvents } from '../../core/db/event-queries'
import { addArtifact, artifactRelatedCommands, type ArtifactAddOutcome, type ArtifactAddResponse } from '../../core/artifacts'

const RELATED_WINDOW_MS = 24 * 60 * 60 * 1000

export function registerArtifactsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('artifacts:add', async (_e, title?: unknown): Promise<ArtifactAddResponse | null> => {
    const proj = ctx.getActiveProject()
    const win = ctx.getMainWindow()
    if (!proj || !win) return null
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      // The renderer passes the title in the operator's language.
      title: typeof title === 'string' && title.trim() ? title.slice(0, 120) : 'Add evidence files'
    })
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true, results: [] }
    // The project may have closed while the picker was open.
    if (ctx.getActiveProject()?.id !== proj.id) return null
    const projectDir = getProjectDir(proj)
    const config = loadConfig(projectDir)
    const results: ArtifactAddOutcome[] = []
    for (const file of picked.filePaths) {
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
    return { canceled: false, results }
  })
}
