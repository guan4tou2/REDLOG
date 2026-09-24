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

const CURSOR_VERSION = 1

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...key })).toString('base64url')
}

export function decodeCursor(opaque: string): CursorKey | null {
  try {
    const parsed = JSON.parse(Buffer.from(opaque, 'base64url').toString())
    if (parsed.v !== CURSOR_VERSION) return null
    if (!Number.isSafeInteger(parsed.ts) || parsed.ts < 0) return null
    if (!Number.isSafeInteger(parsed.row) || parsed.row < 1) return null
    if (parsed.tier !== 'chained' && parsed.tier !== 'logged') return null
    return { ts: parsed.ts, row: parsed.row, tier: parsed.tier }
  } catch {
    return null
  }
}

// Per-arm cursor predicate for use INSIDE each UNION arm's WHERE clause.
// Uses `rowid` (the real SQLite column) instead of the `_row` alias, and
// resolves the tier_rank comparison at build time since each arm's rank is
// a known constant.
//
// This is required when per-arm LIMIT is used: without pushing the cursor
// into each arm, the arm returns its top-N rows regardless of cursor
// position, and the outer cursor filter loses rows past the per-arm cap.
export function buildPerArmCursorWhere(
  cursor: CursorKey,
  armTier: 'chained' | 'logged'
): { sql: string; params: unknown[] } {
  const cursorRank = TIER_RANK[cursor.tier] ?? 0
  const armRank = TIER_RANK[armTier]

  if (armRank < cursorRank) {
    // This arm's tier_rank is strictly less than cursor's, so at the exact
    // (cursor.ts, cursor.row), a row from this arm appears AFTER the cursor
    // in DESC order → include it (rowid <= instead of <).
    return {
      sql: '(timestamp < ? OR (timestamp = ? AND rowid <= ?))',
      params: [cursor.ts, cursor.ts, cursor.row]
    }
  }

  // armRank >= cursorRank: at (cursor.ts, cursor.row), this arm's row is
  // at or before the cursor in DESC order → exclude it (strict <).
  return {
    sql: '(timestamp < ? OR (timestamp = ? AND rowid < ?))',
    params: [cursor.ts, cursor.ts, cursor.row]
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
