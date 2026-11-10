// The density minimap's drawing and its 重點視窗 (focus window) gestures
// (spec 069, Stitch 05). Pure, so the geometry is tested without a renderer.
import { binHeight } from './timelineTimeMap'

/** A window on the track, as fractions of its width: 0 ≤ left, left + width ≤ 1. */
export interface MinimapWindow {
  left: number
  width: number
}

/** Which part of the window the pointer took: the body pans, a grip resizes. */
export type WindowGrip = 'move' | 'start' | 'end'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * The window after dragging `grip` by `dx` (a fraction of the strip's width).
 *
 * Moving keeps the width and stops at either end. A grip moves only its own
 * edge, never past the other edge minus `minWidth` — the narrowest window the
 * zoom limit can still show — so a resize cannot turn the window inside out.
 */
export function dragMinimapWindow(
  start: MinimapWindow,
  grip: WindowGrip,
  dx: number,
  minWidth: number
): MinimapWindow {
  const width = clamp(start.width, 0, 1)
  const left = clamp(start.left, 0, 1 - width)
  const min = clamp(minWidth, 0, 1)
  if (grip === 'move') return { left: clamp(left + dx, 0, 1 - width), width }
  const right = left + width
  if (grip === 'start') {
    const l = clamp(left + dx, 0, Math.max(0, right - min))
    return { left: l, width: right - l }
  }
  const r = clamp(right + dx, Math.min(1, left + min), 1)
  return { left, width: r - left }
}

// A non-empty bin is drawn at 18% at least so one event is visible; zero stays
// zero — "quiet" and "nothing at all" are the whole point of the strip.
function binY(count: number, max: number, h: number): number {
  return h - (count ? 0.18 + binHeight(count, max) * 0.72 : 0) * h
}

const r1 = (v: number): number => Math.round(v * 10) / 10

/**
 * The area under the bins as an SVG path, `w` × `h`, baseline at the bottom.
 * With `range`, only bins `range[0]..range[1]` (inclusive), squared off at the
 * bin edges so a one-bin stretch still has width.
 */
export function densityAreaPath(
  counts: readonly number[],
  max: number,
  w: number,
  h: number,
  range?: readonly [number, number]
): string {
  const n = counts.length
  if (n === 0) return ''
  const step = w / n
  if (range) {
    const i0 = clamp(Math.floor(range[0]), 0, n - 1)
    const i1 = clamp(Math.floor(range[1]), i0, n - 1)
    const pts = [`M ${r1(i0 * step)},${h}`, `L ${r1(i0 * step)},${r1(binY(counts[i0], max, h))}`]
    for (let i = i0; i <= i1; i++) pts.push(`L ${r1((i + 0.5) * step)},${r1(binY(counts[i], max, h))}`)
    pts.push(`L ${r1((i1 + 1) * step)},${r1(binY(counts[i1], max, h))}`, `L ${r1((i1 + 1) * step)},${h} Z`)
    return pts.join(' ')
  }
  const pts = [`M 0,${h}`]
  for (let i = 0; i < n; i++) pts.push(`L ${r1((i + 0.5) * step)},${r1(binY(counts[i], max, h))}`)
  pts.push(`L ${w},${h} Z`)
  return pts.join(' ')
}

/** The bins a time stretch covers, inclusive, on the minimap's linear axis. */
export function binRange(
  start: number,
  end: number,
  timeStart: number,
  timeEnd: number,
  n: number
): [number, number] {
  const span = (timeEnd - timeStart) || 1
  const i0 = clamp(Math.round(((start - timeStart) / span) * n), 0, n - 1)
  const i1 = clamp(Math.round(((end - timeStart) / span) * n) - 1, i0, n - 1)
  return [i0, i1]
}

/** The busiest bin in `range`, the earlier on a tie: where the peak line goes. */
export function peakBin(counts: readonly number[], range: readonly [number, number]): number {
  let best = range[0]
  for (let i = range[0]; i <= range[1]; i++) if (counts[i] > counts[best]) best = i
  return best
}
