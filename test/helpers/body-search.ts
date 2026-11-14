// The events whose saved bodies, taken together, contain every term of
// `query`: the body-index half of what Search matches (an event matches when
// each term is in its own data or in any of its bodies). Tests that ask the
// body index alone use this.
import { searchHttpBodyTermIds } from '../../src/core/http-body-index'
import type { ExportSnapshot } from '../../src/core/export-plan'

export function searchHttpBodyEventIds(query: string, projectDir?: string, excludeAiRaw = false, snapshot?: ExportSnapshot): string[] {
  const terms = searchHttpBodyTermIds(query, projectDir, excludeAiRaw, snapshot)
  if (!terms.length) return []
  const [first, ...rest] = terms
  const sets = rest.map(t => new Set(t.eventIds))
  return first.eventIds.filter(id => sets.every(set => set.has(id)))
}
