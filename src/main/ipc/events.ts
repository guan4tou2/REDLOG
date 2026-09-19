import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import {
  queryEvents, queryEventById, queryByFlowId, searchEvents,
  getEventCount, getLatestLoggedTs, distinctAgentTypes, aggregateTargets,
  queryTargetEventsPage,
  distinctHosts, hostCausalChain, insertEvent,
  type RedLogEvent, type EventTierFilter
} from '../../core/db/events'
import { toggleDoNotExport, isDoNotExport } from '../../core/db/do-not-export'
import { readBody as readHttpBody, type BodyRef } from '../../core/http-body-store'
import { eventBus } from '../../core/event-bus'

export function registerEventsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('events:query', (_e, opts) =>
    ctx.getActiveProject() ? queryEvents(opts) : [])

  ipcMain.handle('events:getCount', (_e, tier?: EventTierFilter) =>
    ctx.getActiveProject() ? getEventCount(tier ? { tier } : undefined) : 0)

  ipcMain.handle('events:getLatestLoggedTs', () =>
    ctx.getActiveProject() ? getLatestLoggedTs() : null)

  ipcMain.handle('events:search', (_e, query: string, limit?: number, opts?: { agentType?: string; since?: number; before?: number }) =>
    ctx.getActiveProject() ? searchEvents(query, limit, opts) : [])

  ipcMain.handle('events:distinctAgentTypes', () =>
    ctx.getActiveProject() ? distinctAgentTypes() : [])

  ipcMain.handle('events:aggregateTargets', () =>
    ctx.getActiveProject() ? aggregateTargets() : [])

  ipcMain.handle('events:queryTargetPage', (_e, opts: { targetId: string; limit?: number; cursor?: string | null }) =>
    ctx.getActiveProject() && typeof opts?.targetId === 'string'
      ? queryTargetEventsPage(opts)
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
