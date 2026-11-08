import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Track-width wiring only. Density zoom and idle-gap behavior are covered by
// timeline-geometry.test.ts, timeline-time-map.test.ts and the presentation E2E.
// These structural guards do not prove rendered layout.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'Timeline.tsx'), 'utf-8'
)
describe('track width (V8)', () => {
  it('fits zoom 1 to the window, with no 2000px floor', () => {
    // V8 made the track max(2000, container) so a 4K display was not left with
    // empty panel. 2026-11-08 (Stitch 05): the 2000px floor went too — on any
    // window narrower than it, 100% was already zoomed in and 重設全貌 did not
    // show the whole span. 100% is now the fit, and the zoom floor.
    expect(SRC).not.toMatch(/MIN_BASE_TRACK_W/)
    expect(SRC, 'baseTrackW is what the scroller shows, else the container minus the label column')
      .toMatch(/const baseTrackW = scrollerW > 0 \? scrollerW : containerW > 0 \? Math\.max\(1, containerW - labelW\) : UNMEASURED_TRACK_W/)
    expect(SRC, 'zoom never goes below the fit').toMatch(/const MIN_ZOOM = 1\b/)
    expect(SRC, 'no hard-coded quarter zoom floor is left').not.toMatch(/Math\.max\(0\.25,/)
    expect(SRC, 'the label column is subtracted only where it renders: the swim lanes')
      .toMatch(/const labelW = timelineMode === 'standard' \? 0 : LABEL_W/)
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

describe('standard ruler wiring', () => {
  it('draws the lane label column only outside the standard mode', () => {
    expect(SRC).toMatch(/\{timelineMode !== 'standard' && \(\s*<div className="shrink-0 border-r[^>]*style=\{\{ width: LABEL_W \}\}/)
  })

  it('keeps the standard track testid on the track, not on a label', () => {
    expect(SRC).toMatch(/data-testid=\{timelineMode === 'standard' \? 'timeline-standard-track' : undefined\}/)
  })

  it('keeps the markers out of pan, double-click and right-click handling', () => {
    expect(SRC).toMatch(/pointer-events-none">\s*\{rulerMarkers\.focus/)
    expect(SRC.match(/closest\('\[data-timeline-marker\]'\)/g)?.length).toBe(2)
  })

  it('shares one resume-follow action between the badge and the [Latest] marker', () => {
    expect(SRC.match(/resumeFollow\(\)/g)?.length).toBe(2)
  })
})
