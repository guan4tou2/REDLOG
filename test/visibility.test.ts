import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  computeVisibility, shouldRefetch, allDisclosed, UNLOCK, DAY_ONE, EMPTY_SIGNALS,
  type VisibilitySignals
} from '../src/renderer/src/lib/visibility'
import { DEFAULT_ORDER } from '../src/renderer/src/lib/sidebarOrder'

// docs/UIUX-STANDARD.md §22. One rule: a noun does not appear before its data
// exists. The tests that matter are not "the set is filtered" — they are that a
// noun never unlocks onto a page that has nothing on it, that nothing ever
// disappears again, and that the model cannot become a fact about the operator
// rather than about the engagement.

const S = (over: Partial<VisibilitySignals> = {}): VisibilitySignals => ({ ...EMPTY_SIGNALS, ...over })
const viewsOf = (s: VisibilitySignals, showAll = false): string[] =>
  DEFAULT_ORDER.filter((id) => computeVisibility(s, showAll).views.has(id))

describe('day one', () => {
  it('shows exactly somewhere to look, somewhere to read, and somewhere to type', () => {
    expect(viewsOf(EMPTY_SIGNALS)).toEqual([...DAY_ONE].sort(
      (a, b) => DEFAULT_ORDER.indexOf(a) - DEFAULT_ORDER.indexOf(b)
    ))
    expect(viewsOf(EMPTY_SIGNALS)).toHaveLength(3)   // + the pinned Settings row = four buttons
  })

  it('says it is the first run, and hides a tier distinction that does not exist yet', () => {
    const v = computeVisibility(EMPTY_SIGNALS)
    expect(v.firstRun).toBe(true)
    expect(v.tierChip).toBe(false)
    expect(v.complete).toBe(false)
  })
})

describe('what each noun waits for', () => {
  it('目標 after one target, 範圍 after two', () => {
    expect(viewsOf(S({ targetCount: 1 }))).toContain('targets')
    expect(viewsOf(S({ targetCount: 1 }))).not.toContain('scope')
    expect(viewsOf(S({ targetCount: 2 }))).toContain('scope')
  })

  it('戰利品, 截圖, 標記 and HTTP each after their own first row', () => {
    expect(viewsOf(S({ lootSeen: true }))).toContain('loot')
    expect(viewsOf(S({ screenshotSeen: true }))).toContain('screenshots')
    expect(viewsOf(S({ markSeen: true }))).toContain('marks')
    expect(viewsOf(S({ httpFlowSeen: true }))).toContain('http_history')
  })

  it('搜尋 after there is anything to find', () => {
    expect(viewsOf(EMPTY_SIGNALS)).not.toContain('search')
    expect(viewsOf(S({ evidenceSeen: true }))).toContain('search')
  })

  it('逐字稿 after a finished command or an agent turn', () => {
    expect(viewsOf(S({ transcriptSeen: true }))).toContain('transcript')
  })

  it('never unlocks a page on a signal that is not that page own data', () => {
    // The failure this guards is specific: unlocking a page that then renders
    // empty teaches the operator that the sidebar lies, which is worse than
    // leaving it hidden. Each of these is a signal that LOOKS close enough.
    const proxyTrafficOnly = S({ evidenceSeen: true, httpFlowSeen: true, loggedEver: true })
    expect(viewsOf(proxyTrafficOnly), 'proxy traffic must not unlock 目標/範圍').not.toContain('targets')
    expect(viewsOf(proxyTrafficOnly)).not.toContain('scope')

    const markerEventButNoQuickmark = S({ evidenceSeen: true })
    expect(viewsOf(markerEventButNoQuickmark), 'a marker EVENT is not a quickmark').not.toContain('marks')
  })
})

describe('monotonic', () => {
  it('opens every gate exactly once, and never closes one', () => {
    const steps: Array<Partial<VisibilitySignals>> = [
      { evidenceSeen: true }, { targetCount: 1 }, { targetCount: 2 },
      { transcriptSeen: true }, { lootSeen: true }, { screenshotSeen: true },
      { markSeen: true }, { httpFlowSeen: true }, { loggedEver: true }
    ]
    let s = EMPTY_SIGNALS
    let seen = new Set(viewsOf(s))
    for (const step of steps) {
      s = { ...s, ...step }
      const now = new Set(viewsOf(s))
      for (const v of seen) expect(now.has(v), `${v} disappeared`).toBe(true)
      seen = now
    }
    expect(allDisclosed(s)).toBe(true)
    expect(computeVisibility(s).complete).toBe(true)
  })

  it('keeps a page visible after retention prunes what unlocked it', () => {
    // The logged tier is swept after thirty days. A page vanishing because its
    // evidence aged out would read as the evidence having been destroyed.
    const s = S({ evidenceSeen: true, httpFlowSeen: true, loggedEver: true })
    expect(viewsOf(s)).toContain('http_history')
    // The caller keeps the flag true across a prune; the model never lowers it
    // on its own, which this asserts by construction.
    expect(UNLOCK.http_history(s)).toBe(true)
  })
})

describe('the operator opt-out', () => {
  it('shows every page when it is on', () => {
    expect(viewsOf(EMPTY_SIGNALS, true)).toEqual([...DEFAULT_ORDER])
  })

  it('governs pages only — the tier chip and the first-run screen stay derived', () => {
    // A chip for a distinction the project does not have, or "type your first
    // command" shown to someone who has typed thousands, is noise rather than
    // disclosure.
    const fresh = computeVisibility(EMPTY_SIGNALS, true)
    expect(fresh.tierChip).toBe(false)
    expect(fresh.firstRun).toBe(true)
    const mature = computeVisibility(S({ evidenceSeen: true, loggedEver: true }), true)
    expect(mature.tierChip).toBe(true)
    expect(mature.firstRun).toBe(false)
  })
})

describe('when to look again', () => {
  const row = (agentType: string, subtype?: string, tier?: string): { agentType: string; data: Record<string, unknown>; tier?: string } =>
    ({ agentType, data: subtype ? { subtype } : {}, ...(tier ? { tier } : {}) })

  it('says no once everything is open', () => {
    const s = S({
      evidenceSeen: true, transcriptSeen: true, targetCount: 2, lootSeen: true,
      screenshotSeen: true, markSeen: true, httpFlowSeen: true, loggedEver: true
    })
    expect(shouldRefetch(s, [row('shell', 'command_start')])).toBe(false)
  })

  it('ignores the app talking to itself on a fresh project', () => {
    // A verdict row lands within seconds of opening any project. Treating it as
    // evidence would dismiss the first-run screen before anything was captured.
    expect(shouldRefetch(EMPTY_SIGNALS, [row('system', 'ip_verdict')])).toBe(false)
    expect(shouldRefetch(EMPTY_SIGNALS, [row('cleanup', 'history_clear')])).toBe(false)
  })

  it('reacts to the row that could open a still-closed gate', () => {
    expect(shouldRefetch(EMPTY_SIGNALS, [row('shell', 'command_start')])).toBe(true)
    expect(shouldRefetch(S({ evidenceSeen: true, targetCount: 2 }), [row('loot')])).toBe(true)
    expect(shouldRefetch(S({ evidenceSeen: true, targetCount: 2 }), [row('scanner', 'http_response')])).toBe(true)
    expect(shouldRefetch(S({ evidenceSeen: true, targetCount: 2 }), [row('dns', 'dns_query', 'logged')])).toBe(true)
  })

  it('does not re-probe for a row whose gate is already open', () => {
    const s = S({ evidenceSeen: true, targetCount: 2, transcriptSeen: true, loggedEver: true })
    expect(shouldRefetch(s, [row('shell', 'command_end')])).toBe(false)
  })

  it('handles an empty batch', () => {
    expect(shouldRefetch(EMPTY_SIGNALS, [])).toBe(false)
  })
})

describe('the module boundary', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/src/lib/visibility.ts'), 'utf-8')

  it('stays pure — no React, no window, no core import', () => {
    // The renderer and main bundles share no module graph, and this model is
    // also the thing a test can reason about without a DOM.
    expect(src).not.toMatch(/from 'react'|window\.|localStorage|import .*core\//)
  })

  it('persists nothing — visibility is a projection, not a preference', () => {
    expect(src).not.toMatch(/setItem|getItem|redlog-/)
  })

  it('covers every view in the order, so a new page cannot forget to declare itself', () => {
    for (const id of DEFAULT_ORDER) expect(typeof UNLOCK[id], id).toBe('function')
    expect(Object.keys(UNLOCK).sort()).toEqual([...DEFAULT_ORDER].sort())
  })
})
