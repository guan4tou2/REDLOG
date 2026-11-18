import type { TimelineInterval, TimelineIntervalSet } from './timelineIntervals'

export type IntervalStartCap = 'mark' | 'unloaded'
export type IntervalEndCap = 'ok' | 'failed' | 'no-result' | 'open' | 'open-stub'

export interface IntervalMark {
  key: string
  /** visibleRows 的索引。 */
  row: number
  kind: 'span' | 'point' | 'cluster'
  /** 軌道座標，CSS px。point 的 x1 === x0。 */
  x0: number
  x1: number
  /** 線的中心：row * laneH + TRACK_LINE_Y。 */
  y: number
  /** 點擊區域，寬不小於 MARK_HIT_PX，與鄰居相接於中點。 */
  hitLeft: number
  hitWidth: number
  /** span／point 為 1 段；cluster 為 n 段，依起點排序。 */
  intervals: readonly TimelineInterval[]
  startCap: IntervalStartCap
  /** cluster 取成員中最需要注意的：failed > open > no-result > ok。 */
  endCap: IntervalEndCap
  failed: number
  open: number
  /** null：不印名稱。 */
  label: { side: 'right' | 'left'; maxW: number } | null
}

export interface IntervalLayoutInput {
  set: TimelineIntervalSet
  /** trackKey → 列索引；不在表上的軌不畫。 */
  rowOf: ReadonlyMap<string, number>
  toX: (ts: number) => number
  trackW: number
  laneH: number
  clusterPx: number
  /** 本頁的讀取可能缺少結束列（FR-025）。 */
  endsMayBeMissing: boolean
}

export const TRACK_LINE_Y = 28
export const INTERVAL_MIN_LINE_PX = 14
export const LABEL_MIN_PX = 48
export const LABEL_MAX_PX = 320
export const OPEN_STUB_PX = 16
export const SPAN_DEPTH = 2
/** A count's badge (16) and, when a member failed, its ✕ (to +17), with a gap. */
export const COUNT_FOOTPRINT_PX = 27
/** Half a count's badge (8) plus half a start dot (4): closer, and the badge covers the dot. */
export const COUNT_OVER_DOT_PX = 12

// The set is plain data; neither layout nor viewport filtering reads events.
interface WorkingMark { mark: IntervalMark; unionEnd: number }
const rank: Record<IntervalEndCap, number> = { ok: 0, 'no-result': 1, open: 2, 'open-stub': 2, failed: 3 }

function capOf(iv: TimelineInterval, missing: boolean): IntervalEndCap {
  if (iv.endBasis === 'open') return missing ? 'open-stub' : 'open'
  if (iv.endBasis === 'superseded' || iv.exitCode === null) return 'no-result'
  return iv.exitCode === 0 ? 'ok' : 'failed'
}

function merge(target: WorkingMark, other: WorkingMark): void {
  const a = target.mark, b = other.mark
  // Append in time order without repeatedly copying a growing cluster. A
  // loop, not `push(...b.intervals)`: a spread passes every member as an
  // argument, and a cell holding a long session's commands overflows the stack.
  const members = a.intervals as TimelineInterval[]
  for (const iv of b.intervals) members.push(iv)
  a.kind = 'cluster'
  target.unionEnd = Math.max(target.unionEnd, other.unionEnd)
  a.x1 = target.unionEnd - a.x0 >= INTERVAL_MIN_LINE_PX ? target.unionEnd : a.x0
  a.failed += b.failed
  a.open += b.open
  if (rank[b.endCap] > rank[a.endCap]) a.endCap = b.endCap
}

export function layoutIntervalMarks(input: IntervalLayoutInput): IntervalMark[] {
  const { set, rowOf, toX, trackW, laneH, endsMayBeMissing } = input
  const rows = new Map<number, TimelineInterval[]>()
  for (const iv of set.intervals) {
    const row = rowOf.get(iv.trackKey)
    if (row === undefined) continue
    const own = rows.get(row)
    if (own) own.push(iv); else rows.set(row, [iv])
  }
  const result: IntervalMark[] = []
  for (const [row, own] of rows) {
    // Next distinct known start, computed backwards once (duplicate timestamps
    // must not terminate an open line immediately).
    const nextStarts: (number | null)[] = new Array(own.length)
    let next: number | null = null, beyond: number | null = null
    for (let i = own.length - 1; i >= 0; i--) {
      const ts = own[i].startTs
      if (ts === null) { nextStarts[i] = next; continue }
      if (ts === next) nextStarts[i] = beyond
      else { nextStarts[i] = next; beyond = next; next = ts }
    }
    const known: WorkingMark[] = [], unloadedMarks: WorkingMark[] = []
    own.forEach((iv, i) => {
      const unloaded = iv.startTs === null
      const anchor = toX(iv.startTs ?? iv.endTs!)
      const endCap = capOf(iv, endsMayBeMissing)
      const x0 = unloaded ? anchor - OPEN_STUB_PX : anchor
      const end = unloaded ? anchor : iv.reversed ? anchor : iv.endBasis === 'open'
        ? endsMayBeMissing ? anchor + OPEN_STUB_PX : nextStarts[i] === null ? trackW : toX(nextStarts[i]!)
        : toX(iv.endTs!)
      const point = !unloaded && end - x0 < INTERVAL_MIN_LINE_PX
      const candidate: WorkingMark = { unionEnd: Math.max(x0, end), mark: {
        key: iv.id, row, kind: point ? 'point' : 'span', x0, x1: point ? x0 : end,
        y: row * laneH + TRACK_LINE_Y,
        // S2 has no hit targets. S3 assigns the interactive geometry.
        hitLeft: x0 - 4, hitWidth: Math.max(8, end - x0),
        intervals: [iv], startCap: unloaded ? 'unloaded' : 'mark', endCap,
        failed: endCap === 'failed' ? 1 : 0, open: iv.endBasis === 'open' ? 1 : 0, label: null
      } }
      ;(unloaded ? unloadedMarks : known).push(candidate)
    })
    // Each list is already chronological in TimelineIntervalSet. Merge the
    // two sorted lists: subtracting a fixed 16px preserves the end-only order.
    // A general sort here would turn layout into O(n log n).
    const candidates: WorkingMark[] = []
    let k = 0, u = 0
    while (k < known.length || u < unloadedMarks.length) {
      if (u >= unloadedMarks.length || (k < known.length && known[k].mark.x0 <= unloadedMarks[u].mark.x0)) candidates.push(known[k++])
      else candidates.push(unloadedMarks[u++])
    }
    // Starts in one cell become a count. A count is drawn wider than a start
    // dot and a failed one carries its ✕ to the right, so a cell alone leaves
    // counts in neighbouring cells on top of each other, and the ✕ under the
    // next one: a count also takes every start inside its own footprint, and
    // a mark that has just become a count is folded into the mark it now covers.
    const cells: WorkingMark[] = []
    for (const candidate of candidates) {
      const previous = cells[cells.length - 1]
      const x = candidate.mark.x0
      if (!previous || !(Math.floor(previous.mark.x0 / input.clusterPx) === Math.floor(x / input.clusterPx)
        || (previous.mark.kind === 'cluster' && x - previous.mark.x0 < COUNT_FOOTPRINT_PX))) { cells.push(candidate); continue }
      merge(previous, candidate)
      for (let i = cells.length - 1; i > 0; i--) {
        const before = cells[i - 1], count = cells[i]
        const reach = before.mark.kind === 'cluster' ? COUNT_FOOTPRINT_PX : COUNT_OVER_DOT_PX
        if (count.mark.x0 - before.mark.x0 >= reach) break
        merge(before, count)
        cells.pop()
      }
    }
    const placed: WorkingMark[] = []
    let active: WorkingMark[] = []
    for (const candidate of cells) {
      active = active.filter((a) => a.mark.x1 > candidate.mark.x0)
      if (active.length >= SPAN_DEPTH) merge(active[active.length - 1], candidate)
      else {
        placed.push(candidate)
        if (candidate.mark.x1 > candidate.mark.x0) active.push(candidate)
      }
    }
    // Geometry may place an end-only stub before a known start. Restore each
    // cluster's members to the set's chronological order in one linear pass.
    const owner = new Map<TimelineInterval, IntervalMark>()
    for (const { mark } of placed) {
      for (const iv of mark.intervals) owner.set(iv, mark)
      mark.intervals = []
    }
    for (const iv of own) (owner.get(iv)!.intervals as TimelineInterval[]).push(iv)
    // Reserve name space monotonically. An earlier right-hand name owns its
    // gap; a later left-hand name cannot cover it.
    const obstacles = placed.map(({ mark: m }) => m.x0)
    let cursor = 0, occupiedUntil = 0
    for (const { mark: m } of placed) {
      while (cursor < obstacles.length && obstacles[cursor] <= m.x0) cursor++
      const right = Math.max(0, Math.min(trackW, obstacles[cursor] !== undefined ? obstacles[cursor] - 6 : trackW) - m.x0 - 6)
      const leftEdge = Math.max(0, occupiedUntil, (obstacles[cursor - 2] ?? -6) + 6)
      const left = m.x0 - 6 - leftEdge
      if (m.kind !== 'cluster') {
        if (right >= LABEL_MIN_PX) {
          m.label = { side: 'right', maxW: Math.min(LABEL_MAX_PX, right) }
          occupiedUntil = m.x0 + 6 + m.label.maxW
        } else if (left >= LABEL_MIN_PX && left > right) {
          m.label = { side: 'left', maxW: Math.min(LABEL_MAX_PX, left) }
          occupiedUntil = m.x0 - 6
        }
      }
      result.push(m)
    }
  }
  return result
}

/** View coordinates are CSS px, unlike Timeline's percentage minimap view.
 * No layout or clustering runs during scrolling. */
export function filterVisibleMarks(
  marks: readonly IntervalMark[], trackW: number, viewLeft: number, viewWidth: number,
  rows: { first: number; last: number }
): IntervalMark[] {
  const left = Math.max(0, viewLeft), right = Math.min(trackW, viewLeft + viewWidth)
  return marks.filter((m) => m.row >= rows.first - 1 && m.row <= rows.last + 1
    && m.x0 <= right && m.x1 >= left)
}
