import { querySourceSessions, type SourceSessionRequest } from '../../core/source-sessions'
import { describeEventContent, readEventContent, findEventContent, createContentAnchor, resolveContentAnchor, readContentForClipboard } from '../../core/evidence-content'
import { saveEventContent } from '../../core/saved-content-delivery'
import { clipboard, dialog } from 'electron'
import type { ContentReadRequest, ContentFindRequest } from '../../core/content-contract'
import { queryActivityPage, queryActivityMembers } from '../../core/db/activity-queries'
import type { ActivityRequest, ActivityMembersRequest } from '../../core/activity-contract'
import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import {
  queryEvents, queryEventsPage, queryHttpFlowPage, queryEventById, queryEventCausalChain, queryByFlowId, queryCommandOutput, queryCommandEnds, commandEvidence,
  executeEventQuery, fetchToolCounterparts, type EventQueryRequest, type ToolPairKey,
  countEvents, matchEventIds, type EventCountRequest, type EventMatchRequest,
  getEventCount, distinctAgentTypes, aggregateTargets,
  queryScreenshotPage,
  distinctHosts,
  type RedLogEvent, type EventTierFilter, type EventFilter, type EventQueryOptions
} from '../../core/db/events'
import { loadConfig, snapshotScope } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { toggleDoNotExport, isDoNotExport } from '../../core/db/do-not-export'
import { setEventNote, getEventNote, getAnnotatedIds } from '../../core/db/event-notes'
import { attributionStats } from '../../core/socket-attribution'
import { readBody as readHttpBody, type BodyRef } from '../../core/http-body-store'

export function registerEventsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('events:commandEvidence', () =>
    ctx.getActiveProject() ? commandEvidence() : { builtin: false, external: false })
  const withActiveScope = <T extends Pick<EventFilter, 'inScopeOnly' | 'hidePersonal'>>(opts: T): T => {
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

  ipcMain.handle('events:queryPage', (_e, opts: import('../../core/db/events').HttpFlowQueryOptions) =>
    ctx.getActiveProject()
      ? queryEventsPage(withActiveScope(opts ?? {}))
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:queryHttpFlowPage', (_e, opts: import('../../core/db/events').HttpFlowQueryOptions) =>
    ctx.getActiveProject()
      ? queryHttpFlowPage(withActiveScope(opts ?? {}))
      : { items: [], flowCount: 0, hasMore: false, nextCursor: null })

  ipcMain.handle('events:getCount', (_e, tier: EventTierFilter) =>
    ctx.getActiveProject() ? getEventCount({ tier }) : 0)

  // Spec 017. The renderer parses and sends the result, so it can show how the
  // query was read without a round trip and a parse failure never becomes a
  // query. Scope is still attached here: a renderer-supplied predicate narrows,
  // it never widens past the active project's scope snapshot.
  ipcMain.handle('events:runQuery', (_e, req: EventQueryRequest) => {
    if(!ctx.getActiveProject())return {items:[],hasMore:false,nextCursor:null}
    const result=executeEventQuery({...req,filter:withActiveScope(req.filter??{})})
    if(result.bodyCoverage)result.bodyCoverage.projectId=ctx.getCurrentEngagementId()
    return result
  })

  // A delayed renderer request must not run against a newly opened database.
  const activityRequest = <T extends ActivityRequest>(req: T): T => {
    const project = ctx.getActiveProject()
    const owner = ctx.getCurrentEngagementId()
    if (!project || !owner || req?.projectId !== owner) throw new Error('Activity project changed; reopen the query')
    return { ...req, filter: withActiveScope(req.filter ?? {}) }
  }
  const contentAllowed = (projectId: unknown): boolean => Boolean(ctx.getActiveProject() && typeof projectId === 'string' && projectId === ctx.getCurrentEngagementId())
  ipcMain.handle('events:sourceSessions', (_e, req: SourceSessionRequest) => {
    if (!contentAllowed(req?.projectId)) throw new Error('Source Session project changed; reopen the query')
    return querySourceSessions(req)
  })
  ipcMain.handle('events:activityPage', (_e, req: ActivityRequest) => queryActivityPage(activityRequest(req)))
  ipcMain.handle('events:activityMembers', (_e, req: ActivityMembersRequest) => queryActivityMembers(activityRequest(req)))

  const deniedContent = () => ({ ok: false as const, status: 'denied' as const, message: 'Content project changed; reopen the source' })
  ipcMain.handle('content:list', (_e, req: { projectId: string; eventId: string }) =>
    contentAllowed(req?.projectId) ? describeEventContent(req.projectId, req.eventId) : deniedContent())
  ipcMain.handle('content:read', (_e, req: ContentReadRequest) =>
    contentAllowed(req?.ref?.projectId) ? readEventContent(req) : deniedContent())
  ipcMain.handle('content:find', (_e, req: ContentFindRequest) =>
    contentAllowed(req?.ref?.projectId) ? findEventContent(req) : deniedContent())
  ipcMain.handle('content:anchor', (_e, req: import('../../core/content-contract').ContentAnchorRequest) =>
    contentAllowed(req?.ref?.projectId) ? createContentAnchor(req) : deniedContent())
  ipcMain.handle('content:resolveAnchor', (_e, req: import('../../core/content-contract').ContentAnchor) =>
    contentAllowed(req?.ref?.projectId) ? resolveContentAnchor(req) : deniedContent())
  ipcMain.handle('content:copySaved', (_e, ref: import('../../core/content-contract').ContentRef) => {
    if(!contentAllowed(ref?.projectId))return deniedContent()
    const result=readContentForClipboard(ref)
    if(!result.ok)return result
    try{clipboard.writeText(result.value.text);return {ok:true,value:{bytes:result.value.bytes}}}
    catch(error){return {ok:false,status:'failed',message:String(error)}}
  })
  ipcMain.handle('content:save', async (_e, ref: import('../../core/content-contract').ContentRef) => {
    if(!contentAllowed(ref?.projectId))return deniedContent()
    const checked=readEventContent({ref,limit:4})
    if(!checked.ok)return checked
    const options={defaultPath:`${ref.eventId.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)}-${ref.field}.${checked.value.format==='binary'?'bin':'txt'}`}
    const win=ctx.getMainWindow()
    const chosen=win ? await dialog.showSaveDialog(win,options) : await dialog.showSaveDialog(options)
    if(chosen.canceled||!chosen.filePath)return {ok:true,value:null}
    return saveEventContent(ref,chosen.filePath,()=>contentAllowed(ref.projectId))
  })


  // Spec 038. The Timeline's total and "earlier matches", and the check of
  // rows it already holds, go through the same predicates as its pages. Scope
  // is attached here as for the pages, so the answers agree with them.
  ipcMain.handle('events:count', (_e, req: EventCountRequest) =>
    ctx.getActiveProject()
      ? countEvents({ ...req, filter: withActiveScope(req?.filter ?? {}) })
      : 0)

  ipcMain.handle('events:matchIds', (_e, req: EventMatchRequest) =>
    ctx.getActiveProject()
      ? matchEventIds({ ...req, ids: req?.ids ?? [], filter: withActiveScope(req?.filter ?? {}) })
      : [])

  ipcMain.handle('events:toolCounterparts', (_e, keys: ToolPairKey[]) =>
    ctx.getActiveProject() ? fetchToolCounterparts(keys ?? []) : [])

  ipcMain.handle('events:distinctAgentTypes', () =>
    ctx.getActiveProject() ? distinctAgentTypes() : [])

  ipcMain.handle('events:aggregateTargets', () =>
    ctx.getActiveProject() ? aggregateTargets() : [])

  ipcMain.handle('events:queryScreenshotPage', (_e, opts: { limit?: number; cursor?: string | null; trigger?: string | null }) =>
    ctx.getActiveProject()
      ? queryScreenshotPage(opts ?? {})
      : { items: [], hasMore: false, nextCursor: null })

  ipcMain.handle('events:distinctHosts', () =>
    ctx.getActiveProject() ? distinctHosts() : [])

  ipcMain.handle('events:queryByFlowId', (_e, flowId: string) =>
    ctx.getActiveProject() ? queryByFlowId(flowId) : [])

  ipcMain.handle('events:commandOutput', (_e, commandId: string) => {
    const rows = ctx.getActiveProject() && typeof commandId === 'string' && commandId ? queryCommandOutput(commandId, 2001) : []
    return { items: rows.slice(0, 2000), hasMore: rows.length > 2000 }
  })

  ipcMain.handle('events:commandEnds', (_e, commandIds: string[]) =>
    ctx.getActiveProject() && Array.isArray(commandIds) ? queryCommandEnds(commandIds.map(String)) : [])

  ipcMain.handle('events:getById', (_e, ids: string[]) =>
    ctx.getActiveProject() && Array.isArray(ids)
      ? ids.slice(0, 200).map((id) => queryEventById(String(id))).filter((e): e is RedLogEvent => e !== null)
      : [])

  ipcMain.handle('events:causalChain', (_e, anchorId: string, opts?: { maxDepth?: number; eventLimit?: number }) =>
    ctx.getActiveProject() && typeof anchorId === 'string'
      ? queryEventCausalChain(anchorId, opts ?? {})
      : { anchorId, anchorFound: false, events: [], edges: [], unavailableCauseIds: [], truncated: false })

  ipcMain.handle('events:toggleDoNotExport', (_e, eventId: string) => {
    if (!ctx.getActiveProject() || typeof eventId !== 'string') return null
    return toggleDoNotExport(eventId)
  })

  // An annotation, never a change to the event: the row is hashed and
  // immutable, and a note written an hour later must not touch it.
  ipcMain.handle('events:setNote', (_e, eventId: string, note: unknown) => {
    if (!ctx.getActiveProject() || typeof eventId !== 'string' || typeof note !== 'string') return null
    // Bounded so a paste of a whole stdout cannot become an unreadable note
    // the operator has no way to shorten from the UI.
    return setEventNote(eventId, note.slice(0, 4000))
  })

  // Which events carry a note, in one read. The Timeline needs it per row —
  // an annotated event never folds into a summary, because a row a person
  // reached out and wrote on is not noise to be collapsed.
  // Whether the command→traffic join has produced anything this session. The
  // Timeline needs it to tell "nothing was caused" apart from "this host
  // cannot answer who owns a socket" — the two look identical on screen.
  ipcMain.handle('events:attributionStats', () => attributionStats())

  ipcMain.handle('events:annotatedIds', () => {
    if (!ctx.getActiveProject()) return []
    return [...getAnnotatedIds()]
  })

  ipcMain.handle('events:getNote', (_e, eventId: string) => {
    if (!ctx.getActiveProject() || typeof eventId !== 'string') return null
    return getEventNote(eventId)
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
