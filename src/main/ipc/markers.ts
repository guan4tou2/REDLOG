import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { insertEvent, queryMarkerAmendments, type RedLogEvent } from '../../core/db/events'
import { ingestEvent } from '../../core/ingest'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig } from '../../core/config'
import { redactFields } from '../../core/redaction'
import { amendMarker } from '../../core/marker-amend'
import { isInsideDir } from '../../core/paths'
import { getProjectDir as getOpenProjectDir } from '../../core/db/index'
import { eventBus } from '../../core/event-bus'
import type { ScreenshotAgent } from '../services/screenshot-agent'

export const MARKER_TEXT_FIELDS = ['title', 'notes', 'url'] as const

export function registerMarkersIpc(
  ipcMain: IpcMain,
  ctx: IpcContext,
  screenshotAgent: ScreenshotAgent
): void {
  ipcMain.handle('marker:create', (_e, data: Record<string, unknown>) => {
    const proj = ctx.getActiveProject()
    if (!proj) return null
    const config = loadConfig(getProjectDir(proj))
    const at = data.atTimestamp
    const event = ingestEvent('marker', redactFields({
      title: data.title,
      notes: data.notes,
      severity: data.severity ?? 'info',
      category: data.category ?? 'custom',
      ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { atTimestamp: at } : {}),
      ...(typeof data.url === 'string' && data.url.trim()
        ? { url: data.url.trim().slice(0, 2048) }
        : {})
    }, MARKER_TEXT_FIELDS), { engagementId: config.engagement.id, operatorId: config.operator.id, bypassPause: true })
    return event
  })

  ipcMain.handle('marker:amend', (_e, markerId: string, changes: Record<string, unknown>) => {
    const proj = ctx.getActiveProject()
    if (!proj) return { ok: false, error: 'no-active-project' }
    const config = loadConfig(getProjectDir(proj))
    const result = amendMarker(String(markerId), changes ?? {}, {
      engagementId: config.engagement.id,
      operatorId: config.operator.id
    })
    if (result.ok) eventBus.publish(result.event, { bypassPause: true })
    return result
  })

  ipcMain.handle('marker:amendments', (_e, ids: string[]) =>
    ctx.getActiveProject() && Array.isArray(ids) ? queryMarkerAmendments(ids.map(String)) : [])

  ipcMain.handle('screenshot:capture', (_e, causeEventId?: string) =>
    screenshotAgent.captureNow('manual', causeEventId))

  ipcMain.handle('screenshot:deleteFile', (_e, eventId: string, filePath: string) => {
    try {
      const screenshotDir = path.join(getOpenProjectDir(), 'screenshots')
      const resolved = path.resolve(filePath)
      if (!isInsideDir(screenshotDir, resolved)) return { ok: false, error: 'path outside project' }
      let sha256: string | null = null
      try { sha256 = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') } catch { /* file may already be gone */ }
      fs.unlinkSync(resolved)
      const engId = ctx.getCurrentEngagementId()
      const opId = ctx.getCurrentOperatorId()
      if (engId && opId) {
        const ev = insertEvent('system', {
          subtype: 'screenshot_deleted',
          source_event: eventId,
          _causes: [eventId],
          path: path.basename(resolved),
          sha256_pre_delete: sha256
        }, { engagementId: engId, operatorId: opId })
        if (ev) eventBus.publish(ev)
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
