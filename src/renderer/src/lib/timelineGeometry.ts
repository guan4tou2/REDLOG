// Pure geometry seams lifted out of Timeline.tsx (audit F2 / UX-BACKLOG T5).
//
// Timeline.tsx is ~5000 lines with zero interaction tests — the single place a
// regression hides best. None of it could be unit-tested because the logic was
// tangled with React state and closures. These are the first two seams pulled
// out verbatim: the density-driven zoom ceiling and the pixel-bucket clustering.
// Both are pure, so they get tested without a DOM.

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
  laneTimestamps: readonly (readonly number[])[]
  /** Span of the visible time domain, ms. */
  timeSpan: number
  clusterPx: number
  maxTrackW: number
  minBaseTrackW: number
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
  const { laneTimestamps, timeSpan, clusterPx, maxTrackW, minBaseTrackW } = p
  if (timeSpan <= 0) return 6
  const ceilingGap = (timeSpan * clusterPx) / maxTrackW
  const tightest = tightestLaneGap(laneTimestamps, ceilingGap)
  if (!Number.isFinite(tightest)) return 6
  const neededTrackW = (timeSpan / tightest) * clusterPx
  return Math.max(6, Math.min(maxTrackW / minBaseTrackW, neededTrackW / minBaseTrackW))
}
