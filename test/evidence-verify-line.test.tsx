// @vitest-environment jsdom
//
// The verification block is ONE line by default, beside the Evidence heading,
// so the header is no taller than it was without it: at 800×600 and 200% the
// page below has to stay reachable (e2e/layout-read-states, layout-reliability).
// Everything else is behind a disclosure on that line — but a collapsed line
// never says less than its state deserves: an abnormal state is on the line,
// in words and with a shape, and the line says when there is more.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvidenceHeader } from '../src/renderer/src/components/EvidenceHeader'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues } from '../src/renderer/src/lib/issues'
import { setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'

const NOW = Date.now()
const anchorAt = (over: Partial<ChainAnchorInfo> = {}): ChainAnchorInfo => ({
  id: 'a1', headEventId: 'e2', headHash: 'f'.repeat(64), eventCount: 3,
  calendarReceipts: [], status: 'complete', createdAt: NOW - 60_000, completedAt: null, ...over
})

function install(over: { length?: () => Promise<number>; anchors?: () => Promise<ChainAnchorInfo[]> } = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { count: vi.fn(async () => 0), onNewBatch: () => () => {} },
    bookmarks: { list: vi.fn(async () => []) },
    project: { active: vi.fn(async () => ({ id: 'p1', name: 'demo' })) },
    chain: {
      anchors: vi.fn(over.anchors ?? (async () => [anchorAt()])), length: vi.fn(over.length ?? (async () => 3)),
      verify: vi.fn(), anchorNow: vi.fn(), upgrade: vi.fn(async () => ({ upgraded: 0, scanned: 0 }))
    }
  }
}
const mount = (): void => { render(<I18nProvider><EvidenceHeader page="screenshots" onNavigate={vi.fn()} /></I18nProvider>) }
const line = (): HTMLElement => screen.getByTestId('evidence-verify-line')
const details = (): HTMLElement | null => screen.queryByTestId('evidence-verify-details')
const toggle = (): HTMLElement => within(line()).getByRole('button', { name: /^Details/ })
const intact = { ok: true, walked: 3, anchor: anchorAt(), anchorMatchesWalkedHead: true, authentication: 'verified', signedCount: 3, unsignedCount: 0, noPubKeyCount: 0 }

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); _resetIssues(); setLastVerifyResult(null); vi.restoreAllMocks() })

describe('the collapsed line', () => {
  it('shares one non-wrapping row with the heading, and keeps the facts behind a closed disclosure', async () => {
    install()
    mount()
    const h1 = screen.getByRole('heading', { level: 1 })
    const row = h1.parentElement as HTMLElement
    expect(within(row).getByRole('button', { name: 'Verify' })).toBeTruthy()
    expect(row.className.split(' ')).not.toContain('flex-wrap')
    expect(line().className.split(' ')).not.toContain('flex-wrap')
    // The header is the heading row and the tabs: nothing between them.
    const header = screen.getByTestId('evidence-header')
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'))
    expect(details()).toBeNull()
    expect(header.querySelector('[data-testid="evidence-chain-facts"]')).toBeNull()
  })

  it('opens the disclosure on the toggle, below the row and above the tabs', async () => {
    install()
    mount()
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const d = details() as HTMLElement
    expect(d.compareDocumentPosition(screen.getByRole('tablist')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await waitFor(() => expect(within(d).getByTestId('evidence-chain-facts').textContent).toContain('3 events'))
  })

  it('a clean result stays one line: time, tick, walked count, nothing else, collapsed', async () => {
    setLastVerifyResult(intact, { projectId: 'p1', verifiedAt: NOW })
    install()
    mount()
    await waitFor(() => expect(line().textContent).toContain('✓ Chain intact'))
    expect(line().textContent).toContain('Walked 3 events')
    expect(screen.queryByTestId('evidence-verify-more')).toBeNull()
    expect(details()).toBeNull()
  })

  it('puts a failed anchor on the line while collapsed, in words and with a shape', async () => {
    install({ anchors: async () => [anchorAt({ status: 'failed' })] })
    mount()
    await waitFor(() => expect(line().textContent).toContain('✗ The last anchor failed'))
    expect(details()).toBeNull()
  })

  it('puts a failed chain-length read on the line', async () => {
    install({ length: async () => { throw new Error('db locked') } })
    mount()
    await waitFor(() => expect(line().textContent).toContain('Chain length could not be read'))
  })

  it('puts a failed anchor read on the line', async () => {
    install({ anchors: async () => { throw new Error('db locked') } })
    mount()
    await waitFor(() => expect(line().textContent).toContain('Anchors could not be read'))
  })

  it('shows the worst on the line, says how many more, and opens the disclosure for a verdict that is not clean', async () => {
    setLastVerifyResult({ ok: false, walked: 2, brokenAtEventId: 'e2', brokenReason: 'hash mismatch', anchor: null }, { projectId: 'p1', verifiedAt: NOW })
    install({ anchors: async () => [anchorAt({ status: 'failed' })] })
    mount()
    await waitFor(() => expect(line().textContent).toContain('✗ Chain broken'))
    await waitFor(() => expect(screen.getByTestId('evidence-verify-more').textContent).toBe('+1'))
    // The rest is in the disclosure, which is open because the verdict is not clean.
    await waitFor(() => expect(details()).not.toBeNull())
    expect((details() as HTMLElement).textContent).toContain('The last anchor failed')
  })

  it('never truncates the abnormal part; only the quiet parts may shrink, and they carry a title', async () => {
    setLastVerifyResult(intact, { projectId: 'p1', verifiedAt: NOW })
    install({ length: async () => 9 })
    mount()
    const added = await screen.findByText('▲ 6 added since, not verified')
    expect(added.className).toContain('shrink-0')
    expect(added.className).not.toContain('truncate')
    const time = within(line()).getByText(/^Verified /)
    expect(time.className).toContain('truncate')
    expect(time.getAttribute('title')).toBe(time.textContent)
  })
})

// Sustained traffic: a trailing debounce re-armed on every batch never fired
// while batches kept coming, so "✓ intact · walked N" stood unqualified as
// the chain grew. The re-read is paced (at most one a second), not starved.
describe('under sustained traffic', () => {
  it('re-reads the chain length during a stream of batches, not only after it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      let len = 3
      const listeners = new Set<(e: unknown[]) => void>()
      install({ length: async () => len })
      ;(window.redlog.events as unknown as { onNewBatch: unknown }).onNewBatch = (cb: (e: unknown[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) }
      setLastVerifyResult(intact, { projectId: 'p1', verifiedAt: NOW })
      mount()
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(line().textContent).not.toContain('added since')
      const seen: string[] = []
      // A batch every 300 ms for 5 s; each adds ten rows.
      for (let i = 0; i < 16; i++) {
        len += 10
        act(() => { for (const cb of listeners) cb([{ id: `e${i}`, agentType: 'command' }]) })
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        seen.push(line().textContent ?? '')
      }
      // Before the stream ended (it is still arriving at this point), the line
      // had already said that entries arrived after the walk.
      expect(seen.slice(0, 10).some((s) => /\d+ added since, not verified/.test(s))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// What qualifies a tick is said with the caution treatment, on the line.
describe('emphasis', () => {
  it('counts signatures that were not verified as a caution, on the line and amber in the disclosure', async () => {
    setLastVerifyResult({ ok: true, walked: 1201, anchor: anchorAt(), anchorMatchesWalkedHead: true, authentication: 'none', signedCount: 0, unsignedCount: 1201, noPubKeyCount: 0 }, { projectId: 'p1', verifiedAt: NOW })
    install({ length: async () => 1201 })
    mount()
    await waitFor(() => expect(line().textContent).toContain('▲ 1,201 not signature-checked'))
    fireEvent.click(toggle())
    expect(within(details() as HTMLElement).getByText('Signatures: 0 verified, 1,201 not checked').className).toContain('amber')
  })

  it('says on the line when no anchor was checked, and gives clock anomalies the caution treatment', async () => {
    setLastVerifyResult({ ...intact, anchor: null, clockAnomalies: [{ eventId: 'e2', reason: 'x' }] }, { projectId: 'p1', verifiedAt: NOW })
    install()
    mount()
    await waitFor(() => expect(line().textContent).toContain('▲ Rows only, no anchor checked'))
    expect(screen.getByTestId('evidence-verify-more').textContent).toBe('+1')
    fireEvent.click(toggle())
    const d = details() as HTMLElement
    expect(within(d).getByText(/No anchor yet: only the rows were checked/).className).toContain('amber')
    expect(within(d).getByText(/1 clock anomaly/).className).toContain('amber')
  })

  it('does not call an idle, fully anchored chain stale', async () => {
    install({ length: async () => 3, anchors: async () => [anchorAt({ createdAt: NOW - 50 * 3_600_000, eventCount: 3 })] })
    mount()
    await waitFor(() => expect(window.redlog.chain.length).toHaveBeenCalled())
    await waitFor(() => expect(line().textContent).toContain('Not verified yet'))
    expect(line().textContent).not.toContain('No successful anchor')
  })

  it('calls it stale when entries are waiting for an anchor', async () => {
    install({ length: async () => 5, anchors: async () => [anchorAt({ createdAt: NOW - 50 * 3_600_000, eventCount: 3 })] })
    mount()
    await waitFor(() => expect(line().textContent).toContain('No successful anchor for 2 days'))
  })

  it('re-reads the anchors on an interval, so a fresh anchor clears "stale" without waiting for an event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      install()
      mount()
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      const calls = (window.redlog.chain.anchors as ReturnType<typeof vi.fn>).mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
      expect((window.redlog.chain.anchors as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says "Not anchored yet" once, without a count beside it', async () => {
    install({ length: async () => 5, anchors: async () => [] })
    mount()
    fireEvent.click(toggle())
    const facts = within(details() as HTMLElement).getByTestId('evidence-chain-facts')
    await waitFor(() => expect(facts.textContent).toContain('Not anchored yet'))
    expect(facts.textContent).not.toContain('not anchored')
  })
})
