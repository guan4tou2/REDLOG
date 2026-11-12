import { resolveContentAnchor } from '../../core/evidence-content'
import type { ContentAnchor } from '../../core/content-contract'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { insertEvent, queryEventById, queryMarkerAmendments, type RedLogEvent } from '../../core/db/events'
import { ingestEvent } from '../../core/ingest'
import { getProjectDir } from '../../core/project-manager'
import { loadConfig } from '../../core/config'
import { redactFields } from '../../core/redaction'
import { amendMarker } from '../../core/marker-amend'
import { resolveContainedFile } from '../../core/contained-file'
import { MARKER_TITLE_MAX, MARKER_NOTES_MAX, capMarkerText } from '../../core/marker-text'
import { getProjectDir as getOpenProjectDir } from '../../core/db/index'
import { eventBus } from '../../core/event-bus'
import type { ScreenshotAgent } from '../services/screenshot-agent'

export const MARKER_TEXT_FIELDS = ['title', 'notes', 'url'] as const

const DAY_MS = 24 * 3_600_000

/** A HUD marker draft is bound to the project open when it was started. No
 *  binding (older caller) is accepted; a different project is refused. */
export function hudDraftBelongsHere(bind: string | undefined, currentEngagementId: string): boolean {
  return bind === undefined || bind === currentEngagementId
}

/** The fields of a marker added from the HUD form. `at` is when the operator
 *  clicked "Add marker"; it is believed only if it is a real moment in the last
 *  day, otherwise the marker is timed at `now` rather than at a value nobody
 *  can vouch for. An empty title is allowed and named after the time, which is
 *  what a bare mark has always been called. */
export function hudMarkerFields(
  input: { title?: unknown; notes?: unknown; at?: unknown },
  now: number
): { title: string; notes: string; source_timestamp: number; source: 'hud' | 'hud-instant' } {
  const at = typeof input.at === 'number' && Number.isFinite(input.at) && input.at <= now && input.at > now - DAY_MS
    ? input.at : now
  const title = (typeof input.title === 'string' ? input.title : '').trim().slice(0, MARKER_TITLE_MAX)
  const notes = capMarkerText(input.notes, MARKER_NOTES_MAX) ?? ''
  return {
    title: title || `HUD mark ${new Date(at).toLocaleTimeString()}`,
    notes,
    source_timestamp: at,
    // A bare mark is marked as such, so a reviewer knows a time-only title is
    // intentional.
    source: notes || title ? 'hud' : 'hud-instant'
  }
}

/** Event ids a marker may cite: strings of a sane length, at most 20. */
export function markerCauses(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128))].slice(0, 20)
}

/** Delete a screenshot's file and chain the deletion. Only the file of a
 *  screenshot event in the open project, and only a regular file: for a link,
 *  the hash recorded was of the file it pointed at while only the link was
 *  removed, so the chain described a deletion that had not happened. */
export function deleteScreenshotFile(
  eventId: unknown,
  filePath: unknown,
  ids: { engagementId: string | null; operatorId: string | null }
): { ok: true } | { ok: false; error: string } {
  if (typeof eventId !== 'string' || !eventId || typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid request' }
  const screenshotDir = path.join(getOpenProjectDir(), 'screenshots')
  const event = queryEventById(eventId)
  const recorded = event?.agentType === 'screenshot' && typeof event.data?.filePath === 'string' ? event.data.filePath : null
  if (!recorded || path.resolve(recorded) !== path.resolve(filePath)) return { ok: false, error: 'not a screenshot of this project' }
  const file = resolveContainedFile(screenshotDir, filePath)
  if (!file) return { ok: false, error: 'not a screenshot file in this project' }
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.unlinkSync(file)
  if (ids.engagementId && ids.operatorId) {
    const ev = insertEvent('system', {
      subtype: 'screenshot_deleted',
      source_event: eventId,
      _causes: [eventId],
      path: path.basename(file),
      sha256_pre_delete: sha256
    }, { engagementId: ids.engagementId, operatorId: ids.operatorId })
    if (ev) eventBus.publish(ev)
  }
  return { ok: true }
}

export function registerMarkersIpc(
  ipcMain: IpcMain,
  ctx: IpcContext,
  screenshotAgent: ScreenshotAgent
): void {
  ipcMain.handle('marker:create', (_e, data: Record<string, unknown>) => {
    const proj = ctx.getActiveProject()
    if (!proj) return null
    const config = loadConfig(getProjectDir(proj))
    const anchor=data.contentAnchor as ContentAnchor | undefined
    if(anchor){
      if(anchor.ref?.projectId!==config.engagement.id)throw new Error('Evidence fragment project changed')
      const verified=resolveContentAnchor(anchor)
      if(!verified.ok)throw new Error(verified.message)
    }
    const causes=markerCauses([...(Array.isArray(data.causes)?data.causes:[]),...(anchor?[anchor.ref.eventId]:[])])
    const at = data.atTimestamp
    const event = ingestEvent('marker', redactFields({
      ...(anchor ? { contentAnchor: {v:anchor.v,coordinate:anchor.coordinate,ref:{projectId:anchor.ref.projectId,eventId:anchor.ref.eventId,field:anchor.ref.field,version:anchor.ref.version},start:anchor.start,end:anchor.end,sha256:anchor.sha256} } : {}),
      title: capMarkerText(data.title, MARKER_TITLE_MAX),
      notes: capMarkerText(data.notes, MARKER_NOTES_MAX),
      severity: data.severity ?? 'info',
      category: data.category ?? 'custom',
      ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { atTimestamp: at } : {}),
      ...(typeof data.url === 'string' && data.url.trim()
        ? { url: data.url.trim().slice(0, 2048) }
        : {}),
      // #225: a step picked in the transcript cites the events it is about.
      // The marker is a new chained row; the cited events are not touched.
      ...(causes.length > 0 ? { _causes: causes } : {})
    }, MARKER_TEXT_FIELDS), {
      engagementId: config.engagement.id, operatorId: config.operator.id, bypassPause: true,
      ...(typeof data.targetId === 'string' && data.targetId.trim() ? { targetId: data.targetId.trim().slice(0, 253) } : {})
    })
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

  ipcMain.handle('screenshot:capture', (_e, causeEventId?: string, opts?: { heldFrame?: unknown; hideOwnWindows?: unknown }) =>
    screenshotAgent.captureNow('manual', typeof causeEventId === 'string' ? causeEventId : undefined, {
      heldFrame: typeof opts?.heldFrame === 'string' ? opts.heldFrame : undefined,
      hideOwnWindows: opts?.hideOwnWindows === true
    }))

  ipcMain.handle('screenshot:deleteFile', (_e, eventId: string, filePath: string) => {
    try {
      return deleteScreenshotFile(eventId, filePath, {
        engagementId: ctx.getCurrentEngagementId(),
        operatorId: ctx.getCurrentOperatorId()
      })
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
