import { activityKey } from './activity-projection'
import { sourceSessionKey } from './operation-pair-key'
import { getReadonlyDB } from './db/index'
import { executeEventQuery, queryEventsPage, queryHttpFlowPage, iterateCommandOutput, type EventFilter, type RedLogEvent } from './db/events'
import { parseQuery } from './query/contract'
import type { NormalizedExportRequest, ExportScopeSnapshot, ExportSnapshot } from './export-plan'

/** Resolve membership from persisted predicates, never a renderer page. */
export function* iterateExportSelection(request: NormalizedExportRequest, snapshot: ExportSnapshot, scope: ExportScopeSnapshot): IterableIterator<RedLogEvent> {
  const subset = request.subset
  if (subset.kind === 'activity' || subset.kind === 'session') {
    // Validate the rendered dataset before resolving a source namespace. A
    // reused rowid after retention cannot substitute an unrelated source.
    const db = getReadonlyDB()
    for (const [table,max,count,tail] of [
      ['events',subset.snapshot.chainedMaxRowId,subset.snapshot.chainedCount,subset.snapshot.chainedTailId],
      ['events_logged',subset.snapshot.loggedMaxRowId,subset.snapshot.loggedCount,subset.snapshot.loggedTailId]
    ] as const) {
      const row=db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE rowid<=?`).get(max) as {n:number}
      const last=max ? (db.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(max) as {id:string}|undefined)?.id : null
      if(row.n!==count || last!==tail) throw new Error('Operation dataset changed; refresh the selection')
    }
    let anchor: RedLogEvent | undefined
    for (const event of iterateSnapshotEvents(subset.snapshot)) {
      if (event.engagementId === subset.projectId && event.id === subset.anchorEventId) { anchor = event; break }
    }
    if(!anchor) throw new Error('Operation source unavailable')
    const key=subset.kind==='activity' ? activityKey(anchor) : sourceSessionKey(anchor)
    if(!key) throw new Error('Session identity is unavailable')
    for (const event of iterateSnapshotEvents(subset.snapshot)) {
      if (event.engagementId === subset.projectId && (subset.kind === 'activity' ? activityKey(event) : sourceSessionKey(event)) === key) yield event
    }
    return
  }
  if (subset.kind !== 'selection') {
    yield* iterateSnapshotEvents(snapshot, {
      ...(subset.kind === 'time-range' ? { since: subset.since, before: subset.before, targetId: subset.targetId } : {}),
      ...(request.format === 'har' ? { agentType: 'scanner', tier: 'logged' } : {}) })
    return
  }
  const filter: EventFilter = { ...subset.filter, scope, personalDomains: scope.personalDomains }
  const parsed = parseQuery(subset.query ?? '')
  if (!parsed.ok) throw new Error('Invalid export query')
  const hasQuery = parsed.parsed.conditions.length > 0 || !!parsed.parsed.text.trim()
  if (request.format === 'har' && subset.projection !== 'http') throw new Error('HAR requires an HTTP exchange selection')
  const ids = new Set<string>()
  const commands = new Set<string>()
  const flows = new Set<string>()
  let cursor: string | null = null
  do {
    const page: { items: RedLogEvent[]; hasMore: boolean; nextCursor: string | null } = subset.projection === 'http'
      ? queryHttpFlowPage({ ...filter, http: subset.http, snapshot, cursor, limit: 1000 })
      : hasQuery
        ? executeEventQuery({ parsed: parsed.parsed, filter, snapshot, cursor, limit: 1000, excludeHousekeeping: subset.excludeHousekeeping })
        : queryEventsPage({ ...filter, snapshot, cursor, limit: 1000, excludeHousekeeping: subset.excludeHousekeeping })
    for (const event of page.items) {
      ids.add(event.id)
      if (event.agentType === 'shell' && event.data.subtype === 'command_end'
        && (event.data.late_output === true || event.data.output_streamed === true) && typeof event.data.command_id === 'string') commands.add(event.data.command_id)
      if (event.agentType === 'scanner' && typeof event.data.flow_id === 'string') flows.add(event.data.flow_id)
    }
    cursor = page.hasMore ? page.nextCursor : null
    if (page.hasMore && !cursor) throw new Error('Incomplete export query')
  } while (cursor)
  // Retain membership IDs, not payload arrays. Preserve the output retry
  // deduplication used by the live command reader before canonical ordering.
  for (const command of commands) for (const event of iterateCommandOutput(command, -1, snapshot)) ids.add(event.id)
  for (const event of iterateSnapshotEvents(snapshot)) {
    const companion = subset.projection === 'http' && event.agentType === 'scanner'
      && typeof event.data.flow_id === 'string' && flows.has(event.data.flow_id)
      && ['http_response_chunk', 'ws_message', 'websocket_end'].includes(String(event.data.subtype))
    if (ids.has(event.id) || companion) yield event
  }
}

/** A repeatable frozen read. Each database page releases its rows before the
 * next one is retained; the snapshot excludes concurrent capture appends. */
export function* iterateSnapshotEvents(snapshot: ExportSnapshot, filter: Omit<EventFilter, 'tier'> & { tier?: 'chained' | 'logged' } = {}): IterableIterator<RedLogEvent> {
  let cursor: string | null = null
  do {
    const { tier, ...predicates } = filter
    const page = queryEventsPage({ ...predicates, ...(tier === 'chained' ? { tier } : {}), snapshot, cursor, limit: 512 })
    for (const event of page.items) if (tier !== 'logged' || event.tier === 'logged') yield event
    cursor = page.hasMore ? page.nextCursor : null
    if (page.hasMore && !cursor) throw new Error('Incomplete export query')
  } while (cursor)
}
