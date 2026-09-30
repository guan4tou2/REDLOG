// Gap-compressing time↔pixel mapper, lifted from Timeline.tsx so the layout
// algorithm can be tested without a DOM (audit review §2: "React component
// 不應該負責 event layout algorithm").

export interface TimeMapGap {
  x: number
  from: number
  to: number
}

export interface TimeMap {
  toX: (ts: number) => number
  fromX: (px: number) => number
  gaps: TimeMapGap[]
}

export interface BuildTimeMapParams {
  /** Display timestamps of every event, unsorted is fine. */
  displayTimestamps: readonly number[]
  timeStart: number
  timeEnd: number
  timeSpan: number
  trackW: number
  compressGaps: boolean
  gapMinMs: number
  gapPx: number
}

/**
 * Build a bi-directional time↔pixel mapper.
 *
 * With compression off, the mapping is linear. With compression on, any
 * stretch longer than `gapMinMs` with no events collapses to a fixed
 * `gapPx` so the active periods fill the track.
 */
export function buildTimeMap(p: BuildTimeMapParams): TimeMap {
  const { displayTimestamps, timeStart, timeEnd, timeSpan, trackW, compressGaps, gapMinMs, gapPx } = p

  const linear: TimeMap = {
    toX: (ts) => ((ts - timeStart) / timeSpan) * trackW,
    fromX: (x) => timeStart + (x / trackW) * timeSpan,
    gaps: []
  }
  if (timeSpan <= 0 || displayTimestamps.length === 0) return linear

  const stamps = displayTimestamps.slice().sort((a, b) => a - b)

  type Seg = { t0: number; t1: number; kind: 'live' | 'gap' }
  const segs: Seg[] = []
  let cursor = timeStart
  for (const ts of stamps) {
    if (ts - cursor > gapMinMs) {
      segs.push({ t0: cursor, t1: ts, kind: 'gap' })
      cursor = ts
    }
  }
  if (segs.length === 0) return linear

  const full: Seg[] = []
  let at = timeStart
  for (const g of segs) {
    if (g.t0 > at) full.push({ t0: at, t1: g.t0, kind: 'live' })
    full.push(g)
    at = g.t1
  }
  if (at < timeEnd) full.push({ t0: at, t1: timeEnd, kind: 'live' })

  if (!compressGaps) {
    return {
      ...linear,
      gaps: segs.map((g) => ({ x: linear.toX(g.t0), from: g.t0, to: g.t1 }))
    }
  }

  const liveMs = full.filter((s) => s.kind === 'live').reduce((a, s) => a + (s.t1 - s.t0), 0)
  const gapPxTotal = full.filter((s) => s.kind === 'gap').length * gapPx
  const livePx = Math.max(1, trackW - gapPxTotal)
  if (liveMs <= 0) return linear

  const bounds: Array<{ t0: number; t1: number; x0: number; x1: number; kind: Seg['kind'] }> = []
  let x = 0
  for (const seg of full) {
    const w = seg.kind === 'gap' ? gapPx : ((seg.t1 - seg.t0) / liveMs) * livePx
    bounds.push({ t0: seg.t0, t1: seg.t1, x0: x, x1: x + w, kind: seg.kind })
    x += w
  }

  const find = <K extends 't' | 'x'>(v: number, by: K): typeof bounds[number] => {
    let lo = 0, hi = bounds.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const end = by === 't' ? bounds[mid].t1 : bounds[mid].x1
      if (v > end) lo = mid + 1; else hi = mid
    }
    return bounds[lo]
  }

  return {
    toX: (ts: number): number => {
      const b = find(ts, 't')
      if (b.kind === 'gap') return b.x0
      const f = b.t1 === b.t0 ? 0 : (ts - b.t0) / (b.t1 - b.t0)
      return b.x0 + f * (b.x1 - b.x0)
    },
    fromX: (px: number): number => {
      const b = find(px, 'x')
      if (b.kind === 'gap') return b.t0
      const f = b.x1 === b.x0 ? 0 : (px - b.x0) / (b.x1 - b.x0)
      return b.t0 + f * (b.t1 - b.t0)
    },
    gaps: bounds.filter((b) => b.kind === 'gap').map((b) => ({ x: b.x0, from: b.t0, to: b.t1 }))
  }
}

/** Compute the time domain from a sorted event array. */
export interface DomainBounds {
  timeStart: number
  timeEnd: number
  ticks: number[]
}

export function computeDomainBounds(
  events: readonly { timestamp: number; agentType: string; data?: Record<string, unknown> }[]
): DomainBounds {
  if (events.length === 0) {
    const now = Date.now()
    return { timeStart: now - 3600000, timeEnd: now, ticks: [] }
  }
  let first = events[0].timestamp
  let last = events[events.length - 1].timestamp
  for (const e of events) {
    if (e.agentType !== 'marker') continue
    const at = e.data?.atTimestamp
    if (typeof at === 'number' && at > 0) {
      if (at < first) first = at
      if (at > last) last = at
    }
  }
  const pad = Math.max((last - first) * 0.05, 60000)
  const s = first - pad
  const end = last + pad
  const span = end - s
  const steps = Math.min(Math.max(Math.floor(span / 300000), 4), 20)
  const step = span / steps
  const ts: number[] = []
  for (let i = 0; i <= steps; i++) ts.push(s + i * step)
  return { timeStart: s, timeEnd: end, ticks: ts }
}

/** Compute minimap density bins over the full time range. */
export interface MinimapBins {
  counts: number[]
  max: number
  N: number
}

export function computeBins(
  displayTimestamps: readonly number[],
  timeStart: number,
  timeEnd: number,
  binCount = 120
): MinimapBins {
  const counts = new Array(binCount).fill(0)
  const span = (timeEnd - timeStart) || 1
  for (const ts of displayTimestamps) {
    let i = Math.floor(((ts - timeStart) / span) * binCount)
    i = i < 0 ? 0 : i >= binCount ? binCount - 1 : i
    counts[i]++
  }
  return { counts, max: Math.max(1, ...counts), N: binCount }
}

/**
 * A bin's bar height, 0–1, on a log scale.
 *
 * Linear normalisation does not survive this data. Capture is bursty by
 * construction: a scan puts thousands of rows in one bin and the rest of the
 * engagement puts tens in each of the others. Against `count / max`, a bin
 * holding forty manual operations next to a five-thousand-row scan renders at
 * 0.8% — indistinguishable from a bin holding one. The burst does not just
 * dominate the scale, it erases every other bin's differences, which is the
 * one thing the strip exists to show.
 *
 * `log1p` keeps the ordering and compresses the ratio: the same forty-versus-
 * five-thousand pair reads as 45% against 100%.
 *
 * Zero stays zero. A bin with nothing in it must render as nothing, because
 * the only thing this strip can say that the list cannot is "here is a gap",
 * and a floor applied to an empty bin would fill the gap in.
 */
export function binHeight(count: number, max: number): number {
  if (count <= 0) return 0
  return Math.log1p(count) / Math.log1p(Math.max(1, max))
}
