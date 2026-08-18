import { describe, it, expect } from 'vitest'
import { populatedLanes, visibleLanes, soloLaneOf } from '../src/renderer/src/lib/laneVisibility'

// Pins the lane-visibility rules extracted from Timeline.tsx so the axis refactor
// can lean on them without a behaviour change. The canonical order used in the
// component is the LANES tuple; here a small representative slice stands in.
const LANES = ['shell', 'agent', 'scanner', 'dns', 'pivot', 'loot', 'system'] as const
type Ev = { agentType: string }
const laneOf = (e: Ev): string => e.agentType

describe('populatedLanes', () => {
  it('is empty for no events', () => {
    expect(populatedLanes([], laneOf).size).toBe(0)
  })

  it('collects the distinct lanes that have events', () => {
    const p = populatedLanes([{ agentType: 'shell' }, { agentType: 'shell' }, { agentType: 'dns' }], laneOf)
    expect([...p].sort()).toEqual(['dns', 'shell'])
  })
})

describe('visibleLanes', () => {
  it('keeps only populated, non-hidden lanes in canonical order', () => {
    // populated out of canonical order on purpose — output must follow LANES.
    const populated = new Set(['loot', 'shell', 'dns'])
    const hidden = new Set<string>()
    expect(visibleLanes(LANES, populated, hidden)).toEqual(['shell', 'dns', 'loot'])
  })

  it('drops hidden lanes', () => {
    const populated = new Set(['shell', 'dns', 'loot'])
    const hidden = new Set(['dns'])
    expect(visibleLanes(LANES, populated, hidden)).toEqual(['shell', 'loot'])
  })

  it('excludes lanes that are populated but not in the canonical list', () => {
    const populated = new Set(['shell', 'ghost-lane'])
    expect(visibleLanes(LANES, populated, new Set())).toEqual(['shell'])
  })

  it('is empty when everything populated is hidden', () => {
    const populated = new Set(['shell', 'dns'])
    const hidden = new Set(['shell', 'dns'])
    expect(visibleLanes(LANES, populated, hidden)).toEqual([])
  })
})

describe('soloLaneOf', () => {
  it('is the lone visible lane only when others are explicitly hidden', () => {
    expect(soloLaneOf(['shell'], new Set(['dns', 'loot']))).toBe('shell')
  })

  it('is null when one lane is visible but nothing was hidden (naturally single-lane)', () => {
    // The key distinction: a single-lane engagement is NOT a solo — hidden must
    // be non-empty. Mirrors `visibleLanes.length === 1 && hiddenLanes.size > 0`.
    expect(soloLaneOf(['shell'], new Set())).toBeNull()
  })

  it('is null when more than one lane is visible', () => {
    expect(soloLaneOf(['shell', 'dns'], new Set(['loot']))).toBeNull()
  })

  it('is null when no lane is visible', () => {
    expect(soloLaneOf([], new Set(['shell']))).toBeNull()
  })
})
