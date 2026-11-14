// Pure geometry seams lifted out of Timeline.tsx (audit F2 / UX-BACKLOG T5).
//
// Timeline.tsx is ~5000 lines with zero interaction tests — the single place a
// regression hides best. None of it could be unit-tested because the logic was
// tangled with React state and closures. These are the first two seams pulled
// out verbatim: the density-driven zoom ceiling and the pixel-bucket clustering.
// Both are pure, so they get tested without a DOM.

import type { RedLogEvent } from '../../../core/db/event-types'
import { type LaneId, type PluginEventType, toLane, displayTs } from './timelineDomain'

/**
 * Bucket items that land within the same CLUSTER_PX-wide column into one group,
 * walking left to right. A new bucket starts when floor(x / clusterPx) changes.
 *
 * This is exactly the flush loop the timeline uses to collapse a burst of
 * events on one lane into a single clickable dot. `xOf` returns an item's
 * horizontal pixel position; items must already be in draw order (ascending x).
 */
export function bucketByPixel<T>(items: readonly T[], xOf: (item: T) => number, clusterPx: number): T[][] {
  const out: T[][] = []
  let bucket: T[] = []
  let curBi = NaN
  for (const e of items) {
    const bi = Math.floor(xOf(e) / clusterPx)
    if (bucket.length && bi !== curBi) { out.push(bucket); bucket = [] }
    curBi = bi
    bucket.push(e)
  }
  if (bucket.length) out.push(bucket)
  return out
}

/**
 * The tightest positive gap between two consecutive timestamps within any one
 * lane. `Infinity` when no lane has two events closer than... anything (0 or 1
 * event per lane, or all coincident). `ceilingGap` short-circuits: once a gap
 * this small is found, no smaller gap can raise the zoom ceiling further, so we
 * stop — the same optimisation the inline version made for dense projects.
 */
export function tightestLaneGap(laneTimestamps: readonly (readonly number[])[], ceilingGap = 0): number {
  let tightest = Infinity
  for (const ts of laneTimestamps) {
    for (let i = 1; i < ts.length; i++) {
      const d = ts[i] - ts[i - 1]
      if (d > 0 && d < tightest) {
        tightest = d
        if (ceilingGap > 0 && tightest <= ceilingGap) return tightest
      }
    }
  }
  return tightest
}

export interface MaxZoomParams {
  /** Per-lane ascending display timestamps. */
  laneTimestamps?: readonly (readonly number[])[]
  /** The smallest positive same-lane gap, when the caller keeps it itself
   *  (lib/timelineIncremental). Gives the same ceiling as `laneTimestamps`:
   *  the early exit below only ever stops at a gap that already caps it. */
  tightestGap?: number
  /** Span of the visible time domain, ms. */
  timeSpan: number
  clusterPx: number
  maxTrackW: number
  /** The track width at zoom 1 (the window's track area). */
  baseTrackW: number
}

/**
 * The zoom ceiling, driven by event density (audit V13). A flat ceiling left a
 * sub-second burst of thousands of events permanently collapsed into one
 * cluster whose popup showed only the first 50 — the rest were in the chain and
 * the export but unreachable in the UI. The ceiling now rises to whatever lets
 * the tightest same-lane gap open to `clusterPx`, capped so the track never
 * exceeds `maxTrackW`. Sparse projects keep the floor of 6.
 */
export function computeMaxZoom(p: MaxZoomParams): number {
  const { laneTimestamps, timeSpan, clusterPx, maxTrackW } = p
  const base = Math.max(1, p.baseTrackW)
  if (timeSpan <= 0) return 6
  const ceilingGap = (timeSpan * clusterPx) / maxTrackW
  const tightest = p.tightestGap ?? tightestLaneGap(laneTimestamps ?? [], ceilingGap)
  if (!Number.isFinite(tightest)) return 6
  const neededTrackW = (timeSpan / tightest) * clusterPx
  return Math.max(6, Math.min(maxTrackW / base, neededTrackW / base))
}

// ── Mark sizes ─────────────────────────────────────────────────────
//
// What a cluster draws, in CSS px. The renderer sizes its marks from these, so
// the clustering below and the drawing cannot disagree about how wide a mark is.

/** A plain event dot; severity scales it (`dotShape`). */
export const SINGLE_DOT_PX = 9
/** Clear space kept between two marks' drawn boxes in one lane. */
export const MARK_GAP_PX = 2
/** The hit area a mark asks for: 27 CSS px is ~24 device px under `body { zoom: 0.9 }`. */
export const MARK_HIT_PX = 27
// The count is 11px weight 800 in tabular figures: one digit is under 7px, and
// the badge keeps 4px either side of the number (1px of it is the border).
const COUNT_DIGIT_PX = 7
const COUNT_PAD_PX = 8

/** A counted badge's height, and its width while the number fits inside it. */
export function clusterBadgeSize(count: number): number {
  return Math.min(24, 13 + Math.round(Math.log2(count) * 3))
}

/** A counted badge's drawn width: widened, never shrunk, so every digit fits. */
export function clusterBadgeWidth(count: number): number {
  return Math.max(clusterBadgeSize(count), String(count).length * COUNT_DIGIT_PX + COUNT_PAD_PX)
}

/** A lone event's drawn dot: its width, and how far right of its time it sits. */
export interface SingleMark { w: number; dx: number }
const plainDot = (): SingleMark => ({ w: SINGLE_DOT_PX, dx: 0 })

// ── Cluster building ───────────────────────────────────────────────

export interface TimelineCluster {
  key: string
  lane: LaneId
  li: number
  /** The mean x of the cluster's events; a lone event's own x. */
  x: number
  y: number
  /** Drawn width of the mark (dot or badge), CSS px. */
  w: number
  /** The mark is drawn centred at `x + dx` (a subagent turn's indent). */
  dx: number
  /** Width of the clickable area, centred on the mark: `MARK_HIT_PX`, cut at
   *  the midpoint of the space to a closer neighbour when either of the two is
   *  a count badge, so no badge's click area covers another mark. Two lone
   *  dots keep their full areas and the later one sits on top, as before. */
  hitW: number
  events: RedLogEvent[]
}

interface Group { from: number; to: number; sumX: number; n: number; l: number; r: number; w: number; dx: number }

/**
 * Whether two neighbouring marks must become one. Only a count badge forces a
 * merge, because only a badge hides something when covered: its number. Two
 * lone dots never merge — they stay the marks their 14px buckets made, since a
 * dot's shape (severity, scope) is information and a badge would hide it; a
 * dot or two of overlap between them is drawn, later on top, as it always was.
 * A badge and a dot merge only when their drawn boxes intersect; two badges
 * also keep `MARK_GAP_PX` apart, so their numbers read as separate.
 */
function mustMerge(a: Group, b: Group): boolean {
  if (a.n === 1 && b.n === 1) return false
  return a.r + (a.n > 1 && b.n > 1 ? MARK_GAP_PX : 0) > b.l
}

/**
 * Cluster one lane's events into marks where no count badge overlaps a
 * neighbour.
 *
 * Bucketing by `clusterPx` alone did not guarantee that: two buckets 14px apart
 * each drew a 16–24px badge, so every badge covered half of the next. After
 * bucketing, a left-to-right stack resolves each collision `mustMerge` finds.
 * The incoming mark first tries to take the bucket after it (when those two
 * would have to merge anyway), which moves it right, away from the
 * collision — in an even run that pairs buckets instead
 * of growing one cluster leftwards. When that does not clear it, it merges
 * into the mark on its left, and the result is checked leftwards again. Each
 * bucket is taken once and every merge removes one group, so this is O(n).
 *
 * The events must be in draw order. A swim-lane row is in capture order, and a
 * marker placed earlier (`atTimestamp`) sits out of it, which made a mark
 * hundreds of pixels left of its neighbour look like a collision; such a row is
 * put in display order first (the sort runs only when it is out of order).
 */
function laneClusters(
  rows: readonly RedLogEvent[],
  toX: (ts: number) => number,
  clusterPx: number,
  singleMark: (e: RedLogEvent) => SingleMark
): { groups: Group[]; buckets: RedLogEvent[][] } {
  let evs = rows
  for (let i = 1; i < rows.length; i++) {
    if (displayTs(rows[i]) < displayTs(rows[i - 1])) {
      evs = [...rows].sort((a, b) => displayTs(a) - displayTs(b))
      break
    }
  }
  const buckets = bucketByPixel(evs, (e) => toX(displayTs(e)), clusterPx)
  const shape = (g: Group): Group => {
    if (g.n === 1) {
      const m = singleMark(buckets[g.from][0])
      g.w = m.w; g.dx = m.dx
    } else {
      g.w = clusterBadgeWidth(g.n); g.dx = 0
    }
    const cx = g.sumX / g.n + g.dx
    g.l = cx - g.w / 2
    g.r = cx + g.w / 2
    return g
  }
  const of = (i: number): Group =>
    shape({ from: i, to: i, sumX: buckets[i].reduce((a, e) => a + toX(displayTs(e)), 0), n: buckets[i].length, l: 0, r: 0, w: 0, dx: 0 })
  const join = (a: Group, b: Group): Group =>
    shape({ from: a.from, to: b.to, sumX: a.sumX + b.sumX, n: a.n + b.n, l: 0, r: 0, w: 0, dx: 0 })
  const stack: Group[] = []
  let i = 0
  while (i < buckets.length) {
    let g = of(i++)
    while (stack.length && mustMerge(stack[stack.length - 1], g)) {
      const top = stack[stack.length - 1]
      if (i < buckets.length) {
        const next = of(i)
        // Only a pair that would have to merge anyway: never two lone dots,
        // nor a dot with a badge it does not touch.
        if (mustMerge(g, next)) {
          const right = join(g, next)
          if (!mustMerge(top, right)) { g = right; i++; continue }
        }
      }
      g = join(stack.pop() as Group, g)
    }
    stack.push(g)
  }
  return { groups: stack, buckets }
}

export function buildClusters(
  visibleRows: readonly string[],
  rowEvents: Readonly<Record<string, RedLogEvent[]>>,
  toX: (ts: number) => number,
  laneH: number,
  clusterPx: number,
  pluginTypes: PluginEventType[] | undefined,
  singleMark: (e: RedLogEvent) => SingleMark = plainDot
): TimelineCluster[] {
  const out: TimelineCluster[] = []
  visibleRows.forEach((rowKey, li) => {
    const evs = rowEvents[rowKey]
    if (!evs || !evs.length) return
    const { groups, buckets } = laneClusters(evs, toX, clusterPx, singleMark)
    groups.forEach((g, gi) => {
      const events = g.from === g.to ? buckets[g.from] : buckets.slice(g.from, g.to + 1).flat()
      const cx = g.sumX / g.n + g.dx
      let half = Math.max(MARK_HIT_PX, g.w + 8) / 2
      const prev = groups[gi - 1]
      const next = groups[gi + 1]
      // Only beside a badge: two lone dots may overlap, and cutting there
      // could leave a dot with less hit area than its own size.
      if (prev && (prev.n > 1 || g.n > 1)) half = Math.min(half, cx - (prev.r + g.l) / 2)
      if (next && (next.n > 1 || g.n > 1)) half = Math.min(half, (g.r + next.l) / 2 - cx)
      const colorLane = toLane(events[0].agentType, events[0].data?.subtype as string | undefined, pluginTypes)
      out.push({
        key: `${rowKey}-${events[0].id}`, lane: colorLane, li,
        x: g.sumX / g.n, y: li * laneH + laneH / 2, w: g.w, dx: g.dx, hitW: 2 * half, events
      })
    })
  })
  return out
}

export function filterVisibleClusters(
  clusters: readonly TimelineCluster[],
  trackW: number,
  viewLeft: number,
  viewWidth: number
): TimelineCluster[] {
  if (trackW <= 0) return clusters as TimelineCluster[]
  const leftPx = (viewLeft / 100) * trackW
  const widthPx = (viewWidth / 100) * trackW
  if (widthPx <= 0) return clusters as TimelineCluster[]
  const from = leftPx - widthPx
  const to = leftPx + widthPx * 2
  if (from <= 0 && to >= trackW) return clusters as TimelineCluster[]
  return clusters.filter((c) => c.x >= from && c.x <= to)
}
