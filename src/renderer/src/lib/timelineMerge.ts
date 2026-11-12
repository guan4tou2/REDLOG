import type { RedLogEvent } from '../../../core/db/event-types'
import { eventCompare } from './timelineDomain'

/**
 * Merge a page of rows into the Timeline's sorted store. Rows already held keep
 * their place (the map takes the newer object, as it always has); new rows are
 * merged in by `eventCompare`.
 *
 * It replaces one `binarySearchInsert` per row. A page of older history sorts
 * before everything held, so each of its 200 inserts shifted the whole array:
 * paging a 70 000-row project in was quadratic. A merge is one pass, and a page
 * that lies wholly before (or after) the held rows is a concatenation. The
 * order is the same: `eventCompare` is total over distinct ids, so there is one
 * sorted arrangement and both produce it (test/timeline-merge.test.ts).
 *
 * Returns `sorted` itself when nothing new arrived, else a new array.
 */
export function mergeSortedRows(sorted: RedLogEvent[], byId: Map<string, RedLogEvent>, rows: readonly RedLogEvent[]): RedLogEvent[] {
  const fresh: RedLogEvent[] = []
  for (const e of rows) {
    if (!byId.has(e.id)) fresh.push(e)
    byId.set(e.id, e)
  }
  if (fresh.length === 0) return sorted
  fresh.sort(eventCompare)
  if (sorted.length === 0) return fresh
  if (eventCompare(fresh[fresh.length - 1], sorted[0]) < 0) return fresh.concat(sorted)
  if (eventCompare(fresh[0], sorted[sorted.length - 1]) >= 0) return sorted.concat(fresh)
  const out: RedLogEvent[] = new Array(sorted.length + fresh.length)
  let i = 0, j = 0, k = 0
  while (i < sorted.length && j < fresh.length) {
    out[k++] = eventCompare(fresh[j], sorted[i]) < 0 ? fresh[j++] : sorted[i++]
  }
  while (i < sorted.length) out[k++] = sorted[i++]
  while (j < fresh.length) out[k++] = fresh[j++]
  return out
}
