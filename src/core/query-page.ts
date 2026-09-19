// Shared keyset-cursor pagination primitive for event queries.
//
// Cursor key = (timestamp, _row, tier) — matches the canonical
// ORDER BY timestamp DESC, _row DESC, tier_rank DESC exactly.
//
// _row is SQLite rowid, which is per-table. Two rows from different tiers
// can share the same (timestamp, _row), so tier is the final tie-break.

export interface QueryPage<T> {
  items: T[]
  hasMore: boolean
  nextCursor: string | null
}

export interface CursorKey {
  ts: number
  row: number
  tier: 'chained' | 'logged'
}

const TIER_RANK: Record<string, number> = { chained: 1, logged: 0 }

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

export function decodeCursor(opaque: string): CursorKey | null {
  try {
    const parsed = JSON.parse(Buffer.from(opaque, 'base64url').toString())
    if (
      typeof parsed.ts !== 'number' ||
      typeof parsed.row !== 'number' ||
      (parsed.tier !== 'chained' && parsed.tier !== 'logged')
    ) return null
    return parsed as CursorKey
  } catch {
    return null
  }
}

// Builds the WHERE clause fragment for keyset pagination.
// The cursor condition implements: "strictly before this position in the
// canonical (timestamp DESC, _row DESC, tier_rank DESC) ordering."
//
// Expands to:
//   (timestamp < :ts)
//   OR (timestamp = :ts AND _row < :row)
//   OR (timestamp = :ts AND _row = :row AND tier_rank < :tierRank)
//
// Returns { sql, params } to be AND-ed into existing WHERE conditions.
// `tierExpr` is the SQL expression that produces 0 or 1 for the tier rank
// (e.g. a literal for single-tier queries, or from the SELECT alias).
export function buildCursorWhere(
  cursor: CursorKey,
  tierExpr: string = 'tier_rank'
): { sql: string; params: unknown[] } {
  const rank = TIER_RANK[cursor.tier] ?? 0
  return {
    sql: `(timestamp < ? OR (timestamp = ? AND _row < ?) OR (timestamp = ? AND _row = ? AND ${tierExpr} < ?))`,
    params: [cursor.ts, cursor.ts, cursor.row, cursor.ts, cursor.row, rank]
  }
}

// Takes a raw DB result set fetched with LIMIT+1 and produces a QueryPage.
// `extractCursorKey` pulls the cursor fields from the last item in the page.
export function toQueryPage<T>(
  rows: T[],
  limit: number,
  extractCursorKey: (item: T) => CursorKey
): QueryPage<T> {
  if (rows.length > limit) {
    const items = rows.slice(0, limit)
    const last = items[items.length - 1]
    return {
      items,
      hasMore: true,
      nextCursor: encodeCursor(extractCursorKey(last))
    }
  }
  return {
    items: rows,
    hasMore: false,
    nextCursor: null
  }
}

// SQL fragment for tier_rank in SELECT: chained=1, logged=0.
// Used inside each UNION arm to produce a sortable column.
export const TIER_RANK_CHAINED = '1 AS tier_rank'
export const TIER_RANK_LOGGED = '0 AS tier_rank'

// The canonical ORDER BY for event queries — all surfaces must use this
// exact ordering so cursors produced by one query work with another.
export const CANONICAL_ORDER = 'ORDER BY timestamp DESC, _row DESC, tier_rank DESC'
