// The AUTHORITATIVE half of phase reconstruction. DESIGN-PRINCIPLES §3 says RedLog
// records facts and never writes interpretation as fact: authoritative assertions
// come from exactly two places — the operator (a marker) or primary capture. §8/§11
// make phase an operator axis of the review timeline, and split its derivation in two.
// This module is the "乙" half: phase segments derived *purely* from the operator's
// own phase-change markers. Each such marker is one deliberate, on-chain, attributable
// claim about where a phase begins — so this seam is authoritative and drawn solid.
// The other half (auto-inferred phase, rendered as dashed suggestions) is a separate
// seam and deliberately lives nowhere near this file.
//
// Everything here is a pure value → value transform: no clock, no event store, no
// React. That keeps the authoritative segmentation fully testable and impossible to
// contaminate with live-monitor state (§8: the timeline is a reconstruction surface).

/** One operator phase-change claim: at `ts`, the engagement entered `phase`. */
export interface PhaseMarker {
  ts: number
  phase: string
  /** id of the originating on-chain marker event — this is what makes the claim attributable. */
  markerId: string
}

/** A contiguous stretch of the timeline the operator has assigned to one phase. */
export interface PhaseSegment {
  phase: string
  start: number
  /** where the phase ends; `null` means still in progress (no later marker, no known domain end). */
  end: number | null
  /** the marker that opened this segment — carried through so the UI can attribute/link it. */
  markerId: string
}

// Pure segmentation. Markers are sorted by ts (callers often hand them to us in
// event-store order, but a segmentation is a statement about time). Each marker opens
// a segment whose end is the NEXT marker's ts, so the result is contiguous and
// non-overlapping. The final segment ends at `domainEnd` when the caller knows the
// engagement's right edge (e.g. the last event's ts), otherwise it is left open (null).
//
// Adjacent markers naming the same phase are intentionally NOT merged: re-asserting a
// phase is a distinct operator act with its own markerId and its own chain event, and
// collapsing them would erase that the operator drew the boundary. Two claims, two
// segments — even if the phase string is identical.
export function phaseSegments(markers: PhaseMarker[], domainEnd?: number): PhaseSegment[] {
  if (markers.length === 0) return []

  // Copy before sorting — never mutate the caller's array.
  const sorted = [...markers].sort((a, b) => a.ts - b.ts)

  return sorted.map((m, i) => {
    const next = sorted[i + 1]
    // Interior segments close at the next claim's ts; the last one closes at the known
    // domain end, or stays open (null) when the end is unknown.
    const end = next ? next.ts : domainEnd ?? null
    return { phase: m.phase, start: m.ts, end, markerId: m.markerId }
  })
}

/** The shape of a raw event this seam needs — a structural subset of the full event row. */
export interface MarkerEventLike {
  id: string
  timestamp: number
  agentType: string
  data?: {
    subtype?: string
    phase?: string
    category?: string
    title?: string
  }
}

// Extract the phase-change markers from a stream of raw events — the input side of the
// authoritative seam. We keep only `marker` events (operator assertions, §3) whose data
// signals a phase change, and drop everything else: shell commands, plain finding-note
// markers, inferred detections. A phase change is signalled any of three equivalent ways
// so callers/importers aren't forced into one field: an explicit `subtype: 'phase'`, a
// populated `phase`, or `category: 'phase'`.
//
// The phase name prefers the canonical `data.phase`; a phase marker created through the
// generic marker UI may only carry a `title`, so title is the fallback. Output is sorted
// by ts so it can be fed straight into `phaseSegments`.
export function phaseMarkersFromEvents(events: MarkerEventLike[]): PhaseMarker[] {
  return events
    .filter((e) => {
      if (e.agentType !== 'marker') return false
      const d = e.data
      if (!d) return false
      return d.subtype === 'phase' || d.phase !== undefined || d.category === 'phase'
    })
    .map((e) => ({
      ts: e.timestamp,
      // `?? ''` is a defensive floor: a phase marker with neither field is malformed,
      // but we still return a (empty-named) marker rather than throwing on bad data.
      phase: e.data?.phase ?? e.data?.title ?? '',
      markerId: e.id
    }))
    .sort((a, b) => a.ts - b.ts)
}
