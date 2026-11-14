// The one display order for events: what every list, page, cursor and the
// renderer's sorted stores agree on.
//
//   (timestamp, rowId, tier rank)
//
// `timestamp` is the displayed time. Two events in the same millisecond are
// ordinary — a tool call and its result, a fast command's start and end, a
// replayed request and its response — and before this they were tied on a
// random UUID, so a result could be shown before its call.
//
// `rowId` is the row's SQLite rowid in its own table. Within one tier it is the
// order the rows were ingested: `events` is append-only, and `events_logged`
// only loses rows to retention, which never makes SQLite hand out a rowid
// below one still present. It is stored with the row, so it reads the same
// after a restart, and it is the tie-break the timestamp indexes already carry
// (an index on `timestamp` ends in the rowid), so ordering by it is a walk of
// the index, not a sort.
//
// The two tiers have independent rowids, so across tiers `rowId` only makes
// the order total and repeatable; it does not say which tier's row was
// ingested first. No stored column can (logged rows carry no monotonic stamp,
// and `created_at` is the same coarse millisecond). The tier rank breaks the
// one remaining tie — equal timestamp and equal rowid in both tables.
//
// The order is not the chain's order. The chain is ordered by
// (created_at, rowid) and checked by its own walk; nothing here reads or
// changes it.
//
// No imports beyond a type: the renderer uses this file too.
import type { RedLogEvent } from './db/event-types'
import { compareCodeUnits } from './code-unit-order'

/** chained above logged at an exact (timestamp, rowId) tie. */
export const EVENT_TIER_RANK = { chained: 1, logged: 0 } as const

/** SQL expressions naming the three order keys in one query. */
export interface EventOrderColumns {
  timestamp: string
  row: string
  tierRank: string
}

/** The columns a union of the two tiers projects (`rowid AS _row`,
 *  `1 AS tier_rank` / `0 AS tier_rank`). */
export const EVENT_ORDER_COLUMNS: EventOrderColumns = { timestamp: 'timestamp', row: '_row', tierRank: 'tier_rank' }

/** `ORDER BY` terms (without the keywords) for the display order. */
export function eventOrderBy(dir: 'ASC' | 'DESC', c: EventOrderColumns = EVENT_ORDER_COLUMNS): string {
  return `${c.timestamp} ${dir}, ${c.row} ${dir}, ${c.tierRank} ${dir}`
}

/** A predicate true for rows strictly past position `at` when reading in
 *  `dir` — the keyset cursor condition. `at` holds SQL placeholders (or
 *  expressions) for the cursor row's three keys. */
export function eventOrderAfter(dir: 'ASC' | 'DESC', c: EventOrderColumns, at: EventOrderColumns): string {
  const op = dir === 'ASC' ? '>' : '<'
  return `(${c.timestamp} ${op} ${at.timestamp} OR (${c.timestamp} = ${at.timestamp} AND (${c.row} ${op} ${at.row} OR (${c.row} = ${at.row} AND ${c.tierRank} ${op} ${at.tierRank}))))`
}

/** What the order reads off an event. The tier and rowId may be missing
 *  (a renderer row type that does not carry them); see below. */
export type EventOrderFields = Pick<RedLogEvent, 'id' | 'timestamp'> & { tier?: string; rowId?: number | null }
const tierRank = (tier: string | undefined): number =>
  tier === 'chained' ? EVENT_TIER_RANK.chained : tier === 'logged' ? EVENT_TIER_RANK.logged : -1

/**
 * Ascending display order, the same as `eventOrderBy('ASC')`.
 *
 * A row without `rowId` (read by a query that did not select the rowid) sorts
 * after every row with one in the same millisecond, and among such rows the id
 * decides; a row without a tier ranks below both tiers. Each key treats a missing value as a value of its own, never as
 * "equal to anything", so this is a strict weak order — and, since ids are
 * unique, a total one — whatever mix of rows it is given. The comparator it
 * replaces skipped a key when one side lacked it, which is not transitive, and
 * a merge or binary search over it put rows wherever arrival order left them.
 */
export function compareEventOrder(a: EventOrderFields, b: EventOrderFields): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1
  const ar = typeof a.rowId === 'number' ? a.rowId : Infinity
  const br = typeof b.rowId === 'number' ? b.rowId : Infinity
  if (ar !== br) return ar < br ? -1 : 1
  const at = tierRank(a.tier)
  const bt = tierRank(b.tier)
  if (at !== bt) return at < bt ? -1 : 1
  return compareCodeUnits(a.id, b.id)
}
