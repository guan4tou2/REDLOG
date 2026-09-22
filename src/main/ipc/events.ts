import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import {
  queryEvents, queryEventsPage, queryHttpFlowPage, queryEventById, queryEventCausalChain, queryByFlowId, searchEvents,
  executeEventQuery, fetchToolCounterparts, type EventQueryRequest, type ToolPairKey,
  getEventCount, getLatestLoggedTs, distinctAgentTypes, aggregateTargets,
  queryTargetEventsPage, queryScreenshotPage,
  distinctHosts, hostCausalChain, insertEvent,
  type RedLogEvent, type EventTierFilter, type EventFilter, type EventQueryOptions
} from '../../core/db/events'
import { loadConfig, snapshotScope } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { toggleDoNotExport, isDoNotExport } from '../../core/db/do-not-export'
import { readBody as readHttpBody, type BodyRef } from '../../core/http-body-store'
import { eventBus } from '../../core/event-bus'

export function registerEventsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  const withActiveScope = <T extends EventFilter>(opts: T): T => {
    if (!opts.inScopeOnly && !opts.hidePersonal) return opts
    const project = ctx.getActiveProject()
    if (!project) return opts
    const scope = snapshotScope(loadConfig(getProjectPath(project)))
    return {
      ...opts,
      ...(opts.inScopeOnly ? { scope: { targets: scope.targets, excludeTargets: scope.excludeTargets } } : {}),
      ...(opts.hidePersonal ? { personalDomains: scope.personalDomains } : {})
    }
  }

  ipcMain.handle('events:query', (_e, opts: EventQueryOptions) =>
    ctx.getActiveProject() ? queryEvents(withActiveScope(opts ?? {})) : [])

  ipcMain.handle('events:queryPage', (_e, opts: EventFilter & { limit?: number; cursor?: string | null }) =>
    ctx.getActiveProject()
      ? queryEventsPage(withActiveScope(opts ?? {}))
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:queryHttpFlowPage', (_e, opts: EventFilter & { limit?: number; cursor?: string | null }) =>
    ctx.getActiveProject()
      ? queryHttpFlowPage(withActiveScope(opts ?? {}))
      : { items: [], flowCount: 0, hasMore: false, nextCursor: null })

  ipcMain.handle('events:getCount', (_e, tier: EventTierFilter) =>
    ctx.getActiveProject() ? getEventCount({ tier }) : 0)

  ipcMain.handle('events:getLatestLoggedTs', () =>
    ctx.getActiveProject() ? getLatestLoggedTs() : null)

  ipcMain.handle('events:search', (_e, query: string, limit?: number, opts?: EventFilter) =>
    ctx.getActiveProject() ? searchEvents(query, limit, withActiveScope(opts ?? {})) : [])

  // Spec 017. The renderer parses and sends the result, so it can show how the
  // query was read without a round trip and a parse failure never becomes a
  // query. Scope is still attached here: a renderer-supplied predicate narrows,
  // it never widens past the active project's scope snapshot.
  ipcMain.handle('events:runQuery', (_e, req: EventQueryRequest) =>
    ctx.getActiveProject()
      ? executeEventQuery({ ...req, filter: withActiveScope(req.filter ?? {}) })
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:toolCounterparts', (_e, keys: ToolPairKey[]) =>
    ctx.getActiveProject() ? fetchToolCounterparts(keys ?? []) : [])

  ipcMain.handle('events:distinctAgentTypes', () =>
    ctx.getActiveProject() ? distinctAgentTypes() : [])

  ipcMain.handle('events:aggregateTargets', () =>
    ctx.getActiveProject() ? aggregateTargets() : [])

  ipcMain.handle('events:queryTargetPage', (_e, opts: { targetId: string; limit?: number; cursor?: string | null }) =>
    ctx.getActiveProject() && typeof opts?.targetId === 'string'
      ? queryTargetEventsPage(opts)
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:queryScreenshotPage', (_e, opts: { limit?: number; cursor?: string | null; trigger?: string | null }) =>
    ctx.getActiveProject()
      ? queryScreenshotPage(opts ?? {})
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:distinctHosts', () =>
    ctx.getActiveProject() ? distinctHosts() : [])

  ipcMain.handle('events:hostChain', (_e, host: string, opts?: { chainLimit?: number }) =>
    ctx.getActiveProject() ? hostCausalChain(host, opts ?? {}) : null)

  ipcMain.handle('events:queryByFlowId', (_e, flowId: string) =>
    ctx.getActiveProject() ? queryByFlowId(flowId) : [])

  ipcMain.handle('events:getById', (_e, ids: string[]) =>
    ctx.getActiveProject() && Array.isArray(ids)
      ? ids.slice(0, 200).map((id) => queryEventById(String(id))).filter((e): e is RedLogEvent => e !== null)
      : [])

  ipcMain.handle('events:causalChain', (_e, anchorId: string, opts?: { maxDepth?: number; eventLimit?: number }) =>
    ctx.getActiveProject() && typeof anchorId === 'string'
      ? queryEventCausalChain(anchorId, opts ?? {})
      : { anchorId, anchorFound: false, events: [], edges: [], unavailableCauseIds: [], truncated: false })

  ipcMain.handle('events:logSecretRevealed', (_e, sourceEventId: string, fields: string[]) => {
    const engId = ctx.getCurrentEngagementId()
    const opId = ctx.getCurrentOperatorId()
    if (!engId || !opId) return { ok: false, error: 'no active project' }
    try {
      const ev = insertEvent('system', {
        subtype: 'secret_revealed',
        source_event: sourceEventId,
        fields: Array.isArray(fields) ? fields : []
      }, { engagementId: engId, operatorId: opId })
      if (ev) eventBus.publish(ev)
      return { ok: true, id: ev?.id }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('events:toggleDoNotExport', (_e, eventId: string) => {
    if (!ctx.getActiveProject() || typeof eventId !== 'string') return null
    return toggleDoNotExport(eventId)
  })

  ipcMain.handle('events:isDoNotExport', (_e, eventId: string) => {
    if (!ctx.getActiveProject() || typeof eventId !== 'string') return false
    return isDoNotExport(eventId)
  })

  ipcMain.handle('httpBody:read', (_e, ref: BodyRef) => {
    if (!ctx.getActiveProject()) return null
    return readHttpBody(ref)
  })
}
