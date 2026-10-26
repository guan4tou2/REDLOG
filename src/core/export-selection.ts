import { executeEventQuery, queryEvents, queryEventsPage, queryHttpFlowPage, queryCommandOutput, type EventFilter, type RedLogEvent } from './db/events'
import { parseQuery } from './query/contract'
import type { NormalizedExportRequest, ExportScopeSnapshot, ExportSnapshot } from './export-plan'

/** Resolve membership from persisted predicates, never a renderer page. */
export function resolveExportSelection(request: NormalizedExportRequest, snapshot: ExportSnapshot, scope: ExportScopeSnapshot): RedLogEvent[] {
  const subset = request.subset
  if (subset.kind !== 'selection') {
    return queryEvents({ limit: -1, snapshot,
      ...(subset.kind === 'time-range' ? { since: subset.since, before: subset.before, targetId: subset.targetId } : {}),
      ...(request.format === 'har' ? { agentType: 'scanner', tier: 'logged' } : {}) })
  }
  const filter: EventFilter = { ...subset.filter, scope, personalDomains: scope.personalDomains }
  const parsed = parseQuery(subset.query ?? '')
  if (!parsed.ok) throw new Error('Invalid export query')
  const hasQuery = parsed.parsed.conditions.length > 0 || !!parsed.parsed.text.trim()
  if (request.format === 'har' && subset.projection !== 'http') throw new Error('HAR requires an HTTP exchange selection')
  const events: RedLogEvent[] = []
  let cursor: string | null = null
  do {
    const page: { items: RedLogEvent[]; hasMore: boolean; nextCursor: string | null } = subset.projection === 'http'
      ? queryHttpFlowPage({ ...filter, http: subset.http, snapshot, cursor, limit: 1000 })
      : hasQuery
        ? executeEventQuery({ parsed: parsed.parsed, filter, snapshot, cursor, limit: 1000, excludeHousekeeping: subset.excludeHousekeeping })
        : queryEventsPage({ ...filter, snapshot, cursor, limit: 1000, excludeHousekeeping: subset.excludeHousekeeping })
    events.push(...page.items)
    cursor = page.hasMore ? page.nextCursor : null
    if (page.hasMore && !cursor) throw new Error('Incomplete export query')
  } while (cursor)
  // A background command's later output is rows of its own, hidden from the
  // Timeline and absent from any filter the command matched on. A selection
  // that includes the command includes what it printed afterwards, or the file
  // says `late_output` and holds nothing to show for it. The snapshot bound is
  // applied below, with the rest of the canonical order.
  for (const event of [...events]) {
    if (event.agentType !== 'shell' || event.data.subtype !== 'command_end' || (event.data.late_output !== true && event.data.output_streamed !== true)) continue
    if (typeof event.data.command_id !== 'string') continue
    events.push(...queryCommandOutput(event.data.command_id, -1, snapshot))
  }
  // Execution uses this same canonical order to compare the approved digest.
  const ids = new Set(events.map(event => event.id))
  return queryEvents({ limit: -1, snapshot }).filter(event => ids.has(event.id))
}
