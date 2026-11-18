// @vitest-environment jsdom
//
// A walk that straddles a project change compared A's anchor against B's rows
// (or the reverse), and its verdict was applied to whichever project was open
// when it returned: B's status bar and dashboard said the chain does not
// verify while B's Evidence page said "Not verified yet" — or a clean walk of
// A cleared B's real issue. Such a walk is abandoned: no issue raised or
// cleared, no result cached, one toast that says why.
import { afterEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as Array<{ message: string; opts: unknown }>)
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.push({ message, opts }) }
}))

import { verifyChainWithFeedback } from '../src/renderer/src/lib/chainActions'
import { _resetIssues, raiseIssue, snapshotIssues } from '../src/renderer/src/lib/issues'
import { getOpenVerification, setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'

const t = (k: string): string => k
const chainIssue = (): unknown => snapshotIssues().find((i) => i.id === 'chain')

/** The walk returns `result`; the open project is A when it starts and B when it ends. */
function install(result: Record<string, unknown>): void {
  const ids = ['A', 'B']
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { active: vi.fn(async () => ({ id: ids.shift() ?? 'B', name: 'x' })) },
    chain: { verify: vi.fn(async () => result) }
  }
}

afterEach(() => { _resetIssues(); toasts.length = 0; setLastVerifyResult(null) })

describe('a walk across a project change', () => {
  it('does not raise the chain issue on the project opened during it', async () => {
    install({ ok: false, walked: 1, brokenAtEventId: 'e2', brokenReason: 'x', anchor: null })
    await verifyChainWithFeedback(t)
    expect(chainIssue()).toBeUndefined()
    expect(getOpenVerification()).toBeNull()
    expect(toasts.map((x) => x.message)).toEqual(['evidence.verifyAbandoned'])
  })

  it('does not clear the chain issue of the project opened during it', async () => {
    raiseIssue({ id: 'chain', tier: 'attention', title: 'B does not verify', view: 'screenshots' })
    install({ ok: true, walked: 3, anchor: null })
    await verifyChainWithFeedback(t)
    expect(chainIssue()).toBeTruthy()
    expect(toasts.map((x) => x.message)).toEqual(['evidence.verifyAbandoned'])
  })
})
