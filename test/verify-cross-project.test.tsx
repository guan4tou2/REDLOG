// @vitest-environment jsdom
//
// After "close A, open B" without a reload, B's Timeline showed A's
// broken-chain banner (the cache was read without asking whose result it
// was), and A's chain issue stayed in the store, so B's status bar and
// dashboard said B's chain does not verify.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues, raiseIssue, snapshotIssues } from '../src/renderer/src/lib/issues'
import { noteOpenProject, setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const broken = { ok: false, walked: 1, brokenAtEventId: 'e2', brokenReason: 'hash mismatch' }
const mountTimeline = (): void => { render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>) }

let b: TimelineBridge
beforeEach(() => {
  b = installTimelineBridge({ timelineMode: 'standard' })
  b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)]))
  try { localStorage.clear(); localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
})
afterEach(() => { cleanup(); setLastVerifyResult(null); noteOpenProject(null); _resetIssues() })

describe('a broken walk on A, then B is opened', () => {
  it('A shows the banner; B does not', async () => {
    noteOpenProject('A')
    setLastVerifyResult(broken, { projectId: 'A' })
    mountTimeline()
    expect(await screen.findByTestId('timeline-broken-chain-banner')).toBeTruthy()
    cleanup()
    noteOpenProject('B')
    mountTimeline()
    await waitFor(() => expect(b.queryPage).toHaveBeenCalled())
    expect(screen.queryByTestId('timeline-broken-chain-banner')).toBeNull()
  })

  it("A's chain and anchor issues leave with A", async () => {
    noteOpenProject('A')
    await new Promise((r) => setTimeout(r, 0))
    raiseIssue({ id: 'chain', tier: 'attention', title: 'A does not verify', view: 'screenshots' })
    raiseIssue({ id: 'anchor', tier: 'attention', title: 'A anchor failed', view: 'screenshots' })
    noteOpenProject('B')
    await waitFor(() => expect(snapshotIssues().map((i) => i.id)).toEqual([]))
  })

  it('noting the same project again clears nothing', async () => {
    noteOpenProject('A')
    await new Promise((r) => setTimeout(r, 0))
    raiseIssue({ id: 'chain', tier: 'attention', title: 'A does not verify', view: 'screenshots' })
    noteOpenProject('A')
    await new Promise((r) => setTimeout(r, 0))
    expect(snapshotIssues().map((i) => i.id)).toEqual(['chain'])
  })
})
