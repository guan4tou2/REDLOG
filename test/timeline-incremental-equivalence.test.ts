import { describe, expect, it } from 'vitest'
import type { RedLogEvent } from '../src/core/db/event-types'
import {
  appendedFrom, stepDerivation, type Derivation, type DerivationCache,
  drawnEvents, unfinishedCommands, toolPairs, laneIndex, singleTrack, swimRows, trackGap, laneGap,
  timestampExtent, latestDisplay, displayStamps, collapsibleTurnCount, effectsIndex, foldIndex,
  observationStanding, badgeIndex, sessionBoundaries, drawnMatchIndex, rowsById
} from '../src/renderer/src/lib/timelineIncremental'
import { mapMatchesToDrawn, type DrawnMatchIndex } from '../src/renderer/src/lib/timelineFilters'
import { binarySearchInsert, displayTs, LANES } from '../src/renderer/src/lib/timelineDomain'
import { computeMaxZoom } from '../src/renderer/src/lib/timelineGeometry'
import { distributeLaneEvents, singleTrackEvents } from '../src/renderer/src/lib/timelineFilters'

// The Timeline folds a live flush into its derived structures instead of
// rebuilding them (lib/timelineIncremental). The model is
// timeline-window-equivalence.test.ts: whatever path a flush takes, the result
// must be the one a from-scratch build over the same rows gives. Batches arrive
// in order (the live case, where `extend` does the work) and out of order (a
// row sorting into the middle, where it must refuse and rebuild).

const T0 = 1_700_000_000_000

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function makeRow(r: () => number, n: number, ts: number): RedLogEvent {
  const pick = r()
  const base = { id: `e${n}`, timestamp: ts, engagementId: 'eng', sessionId: 's', createdAt: ts, operatorId: 'op', hostname: 'h' }
  let agentType = 'browser'
  let data: Record<string, unknown> = { subtype: 'http_flow' }
  const cmd = Math.floor(r() * 12)
  if (pick < 0.18) {
    agentType = 'shell'
    const sub = r() < 0.5 ? 'command_start' : r() < 0.95 ? 'command_end' : 'session_end'
    data = { subtype: sub, command_id: `c${cmd}`, command: r() < 0.9 ? `cmd ${cmd}` : `other ${cmd}`, shell: 'zsh', terminalId: 't1', exit_code: r() < 0.5 ? 0 : 1, durationMs: 5000 }
  } else if (pick < 0.3) {
    agentType = 'agent'
    const subs = ['tool_call', 'tool_result', 'user_message', 'assistant_message', 'transcript_snapshot']
    data = { subtype: subs[Math.floor(r() * subs.length)], agent: 'claude', session_id: 'a1', tool_use_id: `u${cmd}`, input: { n: Math.floor(r() * 3) } }
  } else if (pick < 0.36) {
    agentType = 'marker'
    data = r() < 0.4
      ? { subtype: 'amended', markerId: `e${Math.max(0, n - 1 - Math.floor(r() * 20))}`, title: `fix ${n}` }
      : { title: `m${n}`, severity: 'high', ...(r() < 0.5 ? { atTimestamp: ts - Math.floor(r() * 120_000) } : {}) }
  } else if (pick < 0.45) {
    agentType = 'system'
    const subs = ['recording_paused', 'recording_resumed', 'scope_violation', 'scope_cleared', 'anchor_failed', 'event']
    data = { subtype: subs[Math.floor(r() * subs.length)], violation_id: `e${Math.max(0, n - 3)}` }
  } else if (pick < 0.5) {
    agentType = 'scanner'
    data = { subtype: 'finding' }
  }
  if (r() < 0.15) data._causes = [`e${Math.max(0, n - 1 - Math.floor(r() * 10))}`]
  if (r() < 0.03) data._clock_anomaly = { reason: 'skew' }
  return { ...base, agentType, data } as unknown as RedLogEvent
}

/** Feed batches through a sorted store as the panel does and hand each
 *  published array to `check`. */
function run(seed: number, outOfOrder: number, steps: number, check: (all: RedLogEvent[]) => void): void {
  const r = rng(seed)
  const sorted: RedLogEvent[] = []
  let n = 0
  let clock = T0
  for (let step = 0; step < steps; step++) {
    const size = 1 + Math.floor(r() * 8)
    for (let k = 0; k < size; k++) {
      clock += Math.floor(r() * 400)
      const late = r() < outOfOrder
      const ts = late ? T0 + Math.floor(r() * (clock - T0)) : clock
      binarySearchInsert(sorted, makeRow(r, n++, ts))
    }
    check([...sorted])
  }
}

function counting<S, P extends readonly unknown[]>(d: Derivation<S, P>): { d: Derivation<S, P>; extended: () => number } {
  let extended = 0
  return {
    d: { build: d.build, extend: (...a) => { const s = d.extend(...a); if (s !== null) extended++; return s } },
    extended: () => extended
  }
}

/** Walk a derivation through the batches and compare every step with a build. */
function equivalent<S, P extends readonly unknown[]>(
  name: string, d: Derivation<S, P>, params: (all: RedLogEvent[]) => P,
  project: (s: S) => unknown = (s) => s, input: (all: RedLogEvent[]) => RedLogEvent[] = (all) => all
): void {
  describe(name, () => {
    for (const [label, outOfOrder] of [['in order', 0], ['some out of order', 0.1], ['mostly out of order', 0.7]] as const) {
      it(`matches a from-scratch build (${label})`, () => {
        for (const seed of [1, 7, 42]) {
          const { d: probe, extended } = counting(d)
          let cache: DerivationCache<S, P> | null = null
          run(seed, outOfOrder, 120, (all) => {
            const rows = input(all)
            // The parameters are the same objects from step to step, as the
            // panel's state and memos are.
            const p = params(rows)
            cache = stepDerivation(probe, cache, rows, ...p)
            expect(project(cache.state)).toEqual(project(d.build(rows, ...p)))
          })
          if (outOfOrder === 0) expect(extended(), `${name} took the incremental path`).toBeGreaterThan(0)
        }
      })
    }
  })
}

// The drawn rows, the way the panel derives them from the loaded ones.
const drawnOf = (collapse: boolean) => (all: RedLogEvent[]): RedLogEvent[] => drawnEvents.build(all, collapse).out
const noPlugins: [] = []
const pluginTypes = [{ agentType: 'burp', label: 'Burp', lane: 'scanner', pluginId: 'p' }]
const collapsed = new Set(['traffic', 'signals'])
const hidden = new Set(['dns'] as const)
const rows = ['commands', 'shell', 'agent', 'traffic', 'artifacts', 'signals']
const noBadgeSets = new Set<string>()

equivalent('drawn rows (collapse off)', drawnEvents, () => [false] as [boolean], (s) => s.out)
equivalent('drawn rows (collapse on)', drawnEvents, () => [true] as [boolean], (s) => s.out)
equivalent('unfinished commands', unfinishedCommands, () => [] as [], (s) => s.out)
equivalent('tool pairs', toolPairs, () => [] as [])
equivalent('lane index', laneIndex, () => [noPlugins] as [typeof noPlugins], (s) => ({ ...s, counts: [...s.counts] , populated: [...s.populated] }), drawnOf(false))
equivalent('lane index with plugin lanes', laneIndex, () => [pluginTypes] as [typeof pluginTypes], (s) => ({ ...s, counts: [...s.counts], populated: [...s.populated] }), drawnOf(true))
equivalent('standard track', singleTrack, () => [] as [], (s) => s, drawnOf(false))
equivalent('swim-lane rows', swimRows, () => [rows, collapsed, noPlugins, hidden] as never, (s) => s, drawnOf(false))
equivalent('standard track gap', trackGap, () => [] as [], (s) => s.min, (all) => singleTrack.build(drawnOf(false)(all)))
equivalent('lane gap', laneGap, () => [noPlugins] as [typeof noPlugins], (s) => s.min, drawnOf(false))
equivalent('timestamp extent', timestampExtent, () => [] as [])
equivalent('latest display time', latestDisplay, () => [] as [], (s) => s, drawnOf(false))
equivalent('display stamps', displayStamps, () => [] as [], (s) => s, drawnOf(false))
equivalent('collapsible turn count', collapsibleTurnCount, () => [] as [])
equivalent('effects index', effectsIndex, () => [] as [], (s) => [...s], drawnOf(false))
equivalent('fold index', foldIndex, () => [] as [], (s) => [...s], drawnOf(false))
equivalent('observation standing', observationStanding, () => [] as [], (s) => ({ cleared: [...s.cleared], superseded: [...s.superseded] }), drawnOf(false))
equivalent('badge index', badgeIndex, () => [null, noBadgeSets, noBadgeSets] as [null, Set<string>, Set<string>], (s) => [...s], drawnOf(false))
equivalent('session boundaries', sessionBoundaries, () => [] as [], (s) => s, drawnOf(false))

equivalent('drawn-row match index', drawnMatchIndex, () => [] as [], (s) => ({ ids: [...s.index.ids], ends: [...s.index.endByCommand], rows: [...s.index.rowBySession] }), drawnOf(false))
equivalent('rows by id', rowsById, () => [] as [], (s) => [...s.byId])

describe('the `/` box mapped through the kept lookups', () => {
  it('lights the same rows and counts the same hidden ones as the walk over every row', () => {
    for (const collapse of [false, true]) {
      let drawnCache: DerivationCache<{ index: DrawnMatchIndex }, []> | null = null
      let loadedCache: DerivationCache<{ byId: Map<string, RedLogEvent> }, []> | null = null
      const r = rng(11)
      run(5, 0.1, 120, (all) => {
        const drawn = drawnOf(collapse)(all)
        drawnCache = stepDerivation(drawnMatchIndex, drawnCache, drawn)
        loadedCache = stepDerivation(rowsById, loadedCache, all)
        const matched = new Set(all.filter(() => r() < 0.3).map((e) => e.id))
        const plain = mapMatchesToDrawn(matched, all, drawn)
        const kept = mapMatchesToDrawn(matched, all, drawn, { drawn: drawnCache.state.index, loadedById: loadedCache.state.byId })
        expect([...kept.lit].sort()).toEqual([...plain.lit].sort())
        expect(kept.hiddenByCollapse).toBe(plain.hiddenByCollapse)
      })
    }
  })
})

describe('the zoom ceiling from a kept gap', () => {
  it('equals the ceiling computed from the lane timestamps', () => {
    run(3, 0.2, 150, (all) => {
      const events = drawnOf(false)(all)
      const span = events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp + 120_000 : 0
      for (const baseTrackW of [400, 1300, 3000]) {
        const common = { timeSpan: span, clusterPx: 14, maxTrackW: 400_000, baseTrackW }
        const lanes = distributeLaneEvents(events, noPlugins)
        expect(computeMaxZoom({ ...common, tightestGap: trackGap.build(singleTrack.build(events)).min }))
          .toBe(computeMaxZoom({ ...common, laneTimestamps: [singleTrackEvents(events, displayTs).map(displayTs)] }))
        expect(computeMaxZoom({ ...common, tightestGap: laneGap.build(events, noPlugins).min }))
          .toBe(computeMaxZoom({ ...common, laneTimestamps: LANES.map((l) => lanes[l].map(displayTs)) }))
      }
    })
  })
})

describe('appendedFrom', () => {
  it('recognises only an append of the very same rows', () => {
    const a = [{ id: 'a' }, { id: 'b' }] as unknown as RedLogEvent[]
    expect(appendedFrom(a, a)).toBe(2)
    expect(appendedFrom(a, [...a, { id: 'c' } as unknown as RedLogEvent])).toBe(2)
    expect(appendedFrom(a, [a[0]])).toBe(-1)
    expect(appendedFrom(a, [{ id: 'a' } as unknown as RedLogEvent, a[1], a[1]])).toBe(-1)
    expect(appendedFrom(a, [a[1], a[0], a[0]])).toBe(-1)
  })

  it('rebuilds when a parameter changes', () => {
    const rowsA = [{ id: 'a', agentType: 'agent', timestamp: 1, data: { subtype: 'tool_call' } }] as unknown as RedLogEvent[]
    const on = stepDerivation(drawnEvents, null, rowsA, true)
    const off = stepDerivation(drawnEvents, on, rowsA, false)
    expect(on.state.out).toEqual([])
    expect(off.state.out).toEqual(rowsA)
  })
})

