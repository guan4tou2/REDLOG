import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// v0.11.6: AUDIT V8 and V13 are properties of two expressions in Timeline.tsx.
// Both regress silently — the app keeps working, it just wastes the screen or
// refuses to zoom far enough — and staging them in E2E needs a 4K window and a
// thousand-event burst respectively. Asserted against the source instead.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'Timeline.tsx'), 'utf-8'
)

describe('track width (V8)', () => {
  it('treats 2000px as a floor, not a fixed width', () => {
    // The track used to be exactly BASE_TRACK_W * zoom, so a 2560px or 4K
    // display got a 2000px track and a band of empty panel beside it.
    expect(SRC).toMatch(/MIN_BASE_TRACK_W\s*=\s*2000/)
    expect(SRC, 'baseTrackW must take the larger of the floor and the container')
      .toMatch(/const baseTrackW = Math\.max\(MIN_BASE_TRACK_W, containerW[^)]*\)/)
    // Word-boundary anchored: `baseTrackW * zoom` is the new, correct form and
    // would otherwise match a naive search for the old constant.
    expect(SRC, 'no call site should still multiply the old constant')
      .not.toMatch(/\bBASE_TRACK_W\s*\*\s*zoom/)
  })

  it('caps the track so a pathological zoom cannot allocate an unscrollable width', () => {
    expect(SRC).toMatch(/MAX_TRACK_W\s*=\s*[\d_]+/)
    expect(SRC).toMatch(/Math\.min\(MAX_TRACK_W, Math\.round\(baseTrackW \* zoom\)\)/)
  })

  it('measures container width, not just height', () => {
    // The ResizeObserver only reported height before, which is why the width
    // had to be a constant in the first place.
    expect(SRC).toMatch(/setContainerW\(entry\.contentRect\.width\)/)
  })
})

describe('zoom ceiling (V13)', () => {
  it('derives the ceiling from event density instead of a flat 6', () => {
    // A burst of thousands inside one second collapsed into one cluster, and
    // no amount of zooming could separate it: the popup lists 50 and the rest
    // were unreachable through the UI entirely.
    expect(SRC).toMatch(/const maxZoom = useMemo/)
    expect(SRC, 'the ceiling should come from the tightest gap between events')
      .toMatch(/neededTrackW = \(timeSpan \/ tightest\) \* CLUSTER_PX/)
  })

  it('leaves no zoom call site pinned to the old constant', () => {
    // Four sites clamped to 6: the wheel handler, the minimap drag, the +
    // button and the cluster-item "zoom to fit this burst" action.
    const clampedToSix = [...SRC.matchAll(/Math\.min\(6,\s*[^)]*zoom/gi)]
    expect(clampedToSix.map((m) => m[0])).toEqual([])
  })

  it('keeps 6 as the floor, so a sparse project is unchanged', () => {
    expect(SRC).toMatch(/return Math\.max\(6, Math\.min\(MAX_TRACK_W \/ MIN_BASE_TRACK_W/)
  })
})

describe('idle-gap compression (V7)', () => {
  it('detects gaps regardless of the toggle', () => {
    // Gating detection on the toggle made the chip that turns it on
    // unreachable — it only renders when there is something to compress.
    const memo = /const timeMap = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(SRC)
    expect(memo, 'timeMap memo not found').toBeTruthy()
    expect(memo![1], 'the early return must not depend on compressGaps')
      .toMatch(/if \(timeSpan <= 0 \|\| events\.length === 0\) return linear/)
  })

  it('exposes an inverse so screen-to-time conversions follow the same mapping', () => {
    // Six call sites converted px back to a timestamp with the linear formula.
    // Any that still did would silently disagree with the track once the
    // mapping became piecewise.
    expect(SRC).toMatch(/const fromX = useCallback/)
    // The one legitimate occurrence is timeMap's own linear branch, which IS
    // the mapping. Anything outside that memo is a call site that bypassed it.
    const outsideMemo = SRC.replace(/const timeMap = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/, '')
    expect(outsideMemo, 'no call site should invert the mapping by hand')
      .not.toMatch(/timeStart \+ \([^)]*\/ TRACK_W\) \* timeSpan/)
  })

  it('re-renders the scroll anchor when the mapping changes', () => {
    // TRACK_W does not change when compression toggles, so an effect keyed
    // only on TRACK_W would leave scrollLeft pointing at moved content.
    expect(SRC).toMatch(/\}, \[TRACK_W, timeMap, updateView/)
  })
})
