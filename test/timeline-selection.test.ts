import { describe, it, expect } from 'vitest'
import { nextSelection, carriesState } from '../src/renderer/src/lib/timelineSelection'
import type { RedLogEvent } from '../src/core/db/events'

// §6's two axes ask different questions, and the value of testing this
// separately from Timeline.tsx is that the questions are checkable:
//   ← →  reads one producer's story in order
//   ↑ ↓  asks what else was happening at that moment
// The old flat-list walk answered neither — ↓ interleaved lanes, so it landed
// on something unrelated and operators stopped using it.

let seq = 0
const ev = (lane: string, ts: number, data: Record<string, unknown> = {}): RedLogEvent =>
  ({ id: `e${++seq}`, agentType: lane, timestamp: ts, data } as unknown as RedLogEvent)

const ctx = (events: RedLogEvent[], hidden: string[] = []): Parameters<typeof nextSelection>[2] => ({
  events,
  hiddenLanes: new Set(hidden),
  pluginTypes: undefined,
  laneOrder: ['shell', 'http_navigation', 'loot'],
  laneOf: (e) => e.agentType,
  tsOf: (e) => e.timestamp
})

describe('same-lane movement', () => {
  const shellA = ev('shell', 100)
  const httpB = ev('http_navigation', 150)
  const shellC = ev('shell', 200)
  const events = [shellA, httpB, shellC]

  it('skips events in other lanes', () => {
    // The interleaved http event sits between them in time and must not be
    // what → lands on.
    expect(nextSelection('nav-next', shellA, ctx(events))?.id).toBe(shellC.id)
    expect(nextSelection('nav-prev', shellC, ctx(events))?.id).toBe(shellA.id)
  })

  it('stops at the ends of the lane rather than wrapping', () => {
    expect(nextSelection('nav-prev', shellA, ctx(events))).toBeNull()
    expect(nextSelection('nav-next', shellC, ctx(events))).toBeNull()
  })
})

describe('cross-lane movement', () => {
  it('lands on the nearest event in time, not the first in the lane', () => {
    const here = ev('shell', 1000)
    const early = ev('http_navigation', 10)
    const near = ev('http_navigation', 1010)
    expect(nextSelection('nav-lane-down', here, ctx([here, early, near]))?.id).toBe(near.id)
  })

  it('skips a lane that is hidden, and one that is empty', () => {
    const here = ev('shell', 100)
    const loot = ev('loot', 120)
    // http_navigation is empty; with it skipped, ↓ from shell reaches loot.
    expect(nextSelection('nav-lane-down', here, ctx([here, loot]))?.id).toBe(loot.id)
    // And with loot hidden there is nowhere below to go.
    expect(nextSelection('nav-lane-down', here, ctx([here, loot], ['loot']))).toBeNull()
  })

  it('stops at the top and bottom lane', () => {
    const top = ev('shell', 100)
    expect(nextSelection('nav-lane-up', top, ctx([top]))).toBeNull()
  })
})

describe('state skipping', () => {
  it('jumps over the quiet middle of a run', () => {
    const start = ev('shell', 0)
    const noise = Array.from({ length: 50 }, (_, i) => ev('shell', 10 + i, { exitCode: 0 }))
    const failed = ev('shell', 500, { exitCode: 1 })
    const events = [start, ...noise, failed]
    expect(nextSelection('nav-state-next', start, ctx(events))?.id).toBe(failed.id)
  })

  it('goes backwards to the nearest one behind, not the first overall', () => {
    const a = ev('loot', 10)
    const b = ev('loot', 20)
    const here = ev('shell', 30)
    expect(nextSelection('nav-state-prev', here, ctx([a, b, here]))?.id).toBe(b.id)
  })

  it('counts a failure, a severity, a violation and the finding lanes', () => {
    expect(carriesState(ev('shell', 0, { exitCode: 1 }))).toBe(true)
    expect(carriesState(ev('shell', 0, { severity: 'critical' }))).toBe(true)
    expect(carriesState(ev('shell', 0, { inScope: false }))).toBe(true)
    expect(carriesState(ev('loot', 0))).toBe(true)
    expect(carriesState(ev('shell', 0, { exitCode: 0 }))).toBe(false)
  })

  it('does not stop on a marker amendment — a correction is not a second finding', () => {
    // Two ways it would otherwise trip: the marker lane is in the list above,
    // and an amendment that raises severity also matches the `severity` test.
    // Amending one marker three times would put three extra stops in the
    // skip-to-what-changed walk, which is the walk that exists to skip noise.
    expect(carriesState(ev('marker', 0, { title: 'a finding', severity: 'info' }))).toBe(true)
    expect(carriesState(ev('marker', 0, { subtype: 'amended', markerId: 'm1', title: 'corrected' }))).toBe(false)
    expect(carriesState(ev('marker', 0, { subtype: 'amended', markerId: 'm1', severity: 'critical' }))).toBe(false)
  })
})

describe('ends and empty states', () => {
  it('Home and End reach the ends of everything visible', () => {
    const a = ev('shell', 10)
    const b = ev('loot', 900)
    expect(nextSelection('nav-first', b, ctx([a, b]))?.id).toBe(a.id)
    expect(nextSelection('nav-last', a, ctx([a, b]))?.id).toBe(b.id)
  })

  it('starts at the beginning when nothing is selected yet', () => {
    // Otherwise the keyboard is unreachable without first using the mouse.
    const a = ev('shell', 10)
    expect(nextSelection('nav-next', null, ctx([a]))?.id).toBe(a.id)
  })

  it('returns null rather than throwing on an empty timeline', () => {
    for (const move of ['nav-next', 'nav-lane-up', 'nav-state-next', 'nav-first'] as const) {
      expect(nextSelection(move, null, ctx([]))).toBeNull()
    }
  })

  it('reads events in time order even when they arrive out of order', () => {
    const late = ev('shell', 300)
    const early = ev('shell', 100)
    expect(nextSelection('nav-next', early, ctx([late, early]))?.id).toBe(late.id)
  })
})
