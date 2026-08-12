import { describe, it, expect } from 'vitest'
import { phaseSegments, phaseMarkersFromEvents } from '../src/renderer/src/lib/phaseSegments'
import type { PhaseMarker, MarkerEventLike } from '../src/renderer/src/lib/phaseSegments'

// DESIGN-PRINCIPLES §3 (two-tier attributes) draws the line: an operator marker is
// an AUTHORITATIVE assertion, an inferred detection is only a suggestion. §11 splits
// phase reconstruction along that same line — this seam is the "乙" half, the
// authoritative one: phase segmentation derived *purely* from the operator's own
// phase-change markers (each marker is one on-chain, attributable claim). The
// auto-inference half (dashed suggestions) is a different seam and is not tested here.
//
// Two pure functions, so the whole derivation is a value → value transform with no
// clock, no store and no React: phaseMarkersFromEvents (raw events → the phase-change
// markers) and phaseSegments (markers → contiguous, non-overlapping segments).

const M = (ts: number, phase: string, markerId: string): PhaseMarker => ({ ts, phase, markerId })

describe('phaseSegments', () => {
  it('returns nothing for no markers — no operator claim, no authoritative phase', () => {
    // The whole point of this half is that phase is only asserted by the operator.
    // With zero markers there is simply no authoritative segmentation to draw.
    expect(phaseSegments([])).toEqual([])
  })

  it('a single marker opens one open-ended segment when no domain end is known', () => {
    // One claim, still in force: it runs from its own ts to "now / unknown", which we
    // model as end=null (an in-progress phase) rather than inventing an end.
    expect(phaseSegments([M(100, 'recon', 'a')])).toEqual([
      { phase: 'recon', start: 100, end: null, markerId: 'a' }
    ])
  })

  it('a single marker is closed at domainEnd when the domain end is provided', () => {
    // Given the engagement's known end (e.g. last event ts), the final phase is bounded
    // there instead of dangling — this is what lets the rendered band have a right edge.
    expect(phaseSegments([M(100, 'recon', 'a')], 500)).toEqual([
      { phase: 'recon', start: 100, end: 500, markerId: 'a' }
    ])
  })

  it('multiple markers cut back-to-back segments, last one open-ended', () => {
    // Each marker opens a segment; its end is the NEXT marker's ts, so the segments are
    // contiguous and non-overlapping. The last one is left open (end=null) with no domainEnd.
    expect(phaseSegments([M(0, 'recon', 'a'), M(10, 'exploit', 'b'), M(25, 'exfil', 'c')])).toEqual([
      { phase: 'recon', start: 0, end: 10, markerId: 'a' },
      { phase: 'exploit', start: 10, end: 25, markerId: 'b' },
      { phase: 'exfil', start: 25, end: null, markerId: 'c' }
    ])
  })

  it('closes the final segment at domainEnd when provided', () => {
    expect(phaseSegments([M(0, 'recon', 'a'), M(10, 'exploit', 'b')], 40)).toEqual([
      { phase: 'recon', start: 0, end: 10, markerId: 'a' },
      { phase: 'exploit', start: 10, end: 40, markerId: 'b' }
    ])
  })

  it('sorts unordered marker input by ts before segmenting', () => {
    // Callers may hand us markers in event-store order, not time order. Segmentation is
    // a statement about time, so we sort first; the output is always chronological.
    expect(phaseSegments([M(25, 'exfil', 'c'), M(0, 'recon', 'a'), M(10, 'exploit', 'b')])).toEqual([
      { phase: 'recon', start: 0, end: 10, markerId: 'a' },
      { phase: 'exploit', start: 10, end: 25, markerId: 'b' },
      { phase: 'exfil', start: 25, end: null, markerId: 'c' }
    ])
  })

  it('does NOT merge adjacent markers that name the same phase', () => {
    // Each marker is a distinct operator act — re-asserting "recon" is a separate,
    // separately-attributable claim (its own markerId, its own on-chain event). Merging
    // them would erase that the operator marked the boundary twice, so we keep both.
    expect(phaseSegments([M(0, 'recon', 'a'), M(10, 'recon', 'b')])).toEqual([
      { phase: 'recon', start: 0, end: 10, markerId: 'a' },
      { phase: 'recon', start: 10, end: null, markerId: 'b' }
    ])
  })
})

describe('phaseMarkersFromEvents', () => {
  const ev = (
    id: string,
    timestamp: number,
    agentType: string,
    data?: MarkerEventLike['data']
  ): MarkerEventLike => ({ id, timestamp, agentType, data })

  it('picks only marker events whose data signals a phase change', () => {
    // Three independent ways an event says "this is a phase change": an explicit
    // subtype, a phase field, or a category. Any one qualifies.
    const events: MarkerEventLike[] = [
      ev('1', 10, 'marker', { subtype: 'phase', title: 'recon' }),
      ev('2', 20, 'marker', { phase: 'exploit' }),
      ev('3', 30, 'marker', { category: 'phase', title: 'exfil' })
    ]
    expect(phaseMarkersFromEvents(events)).toEqual([
      { ts: 10, phase: 'recon', markerId: '1' },
      { ts: 20, phase: 'exploit', markerId: '2' },
      { ts: 30, phase: 'exfil', markerId: '3' }
    ])
  })

  it('ignores non-marker events and markers that are not phase changes', () => {
    // A shell command, and a plain finding-note marker (no phase signal) must not
    // become phase boundaries — only deliberate phase markers segment the timeline.
    const events: MarkerEventLike[] = [
      ev('s', 5, 'shell', { subtype: 'command_start' }),
      ev('note', 15, 'marker', { subtype: 'finding', title: 'Found an IDOR' }),
      ev('p', 25, 'marker', { subtype: 'phase', title: 'recon' })
    ]
    expect(phaseMarkersFromEvents(events)).toEqual([{ ts: 25, phase: 'recon', markerId: 'p' }])
  })

  it('prefers data.phase for the phase string and falls back to data.title', () => {
    // data.phase is the canonical field; a phase marker created through the generic
    // marker UI may only carry a title, so title is the fallback name.
    const events: MarkerEventLike[] = [
      ev('a', 10, 'marker', { subtype: 'phase', phase: 'exploit', title: 'ignore me' }),
      ev('b', 20, 'marker', { subtype: 'phase', title: 'lateral-movement' })
    ]
    expect(phaseMarkersFromEvents(events)).toEqual([
      { ts: 10, phase: 'exploit', markerId: 'a' },
      { ts: 20, phase: 'lateral-movement', markerId: 'b' }
    ])
  })

  it('returns markers sorted by ts even when events arrive out of order', () => {
    const events: MarkerEventLike[] = [
      ev('late', 30, 'marker', { phase: 'exfil' }),
      ev('early', 10, 'marker', { phase: 'recon' })
    ]
    expect(phaseMarkersFromEvents(events)).toEqual([
      { ts: 10, phase: 'recon', markerId: 'early' },
      { ts: 30, phase: 'exfil', markerId: 'late' }
    ])
  })
})
