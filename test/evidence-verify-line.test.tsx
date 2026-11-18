// @vitest-environment jsdom
//
// The verification block is ONE line by default, beside the Evidence heading,
// so the header is no taller than it was without it: at 800×600 and 200% the
// page below has to stay reachable (e2e/layout-read-states, layout-reliability).
// Everything else is behind a disclosure on that line — but a collapsed line
// never says less than its state deserves: an abnormal state is on the line,
// in words and with a shape, and the line says when there is more.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
