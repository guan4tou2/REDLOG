// @vitest-environment jsdom
//
// Verification lives on the Evidence page (owner's ruling 6, 2026-11-12): a
// block above the tabs, on every tab, with one Verify and the last result of
// this run of the app. The block may never say more than was checked: no
// result after a restart, the count walked rather than the chain's length,
// entries added since named as not verified, and the shared verdict
// (lib/chainActions verifyVerdict) as the headline.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvidenceHeader } from '../src/renderer/src/components/EvidenceHeader'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues, raiseIssue, snapshotIssues } from '../src/renderer/src/lib/issues'
import { setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'

const NOW = Date.now()
const anchorAt = (over: Partial<ChainAnchorInfo> = {}): ChainAnchorInfo => ({
  id: 'a1', headEventId: 'e2', headHash: 'f'.repeat(64), eventCount: 2,
  calendarReceipts: [], status: 'complete', createdAt: NOW - 60_000, completedAt: null, ...over
})
// The latest anchor failed: no calendar accepted it, so it timestamps nothing.
// Its locally stored head still matches the rows, which is what made the old
// panel print "✓ Anchor matches" beside "✗ The last anchor failed".
const anchor = anchorAt({ status: 'failed' })
const accepted = anchorAt()

const batches = new Set<(e: unknown[]) => void>()
interface Bridge { verify: ReturnType<typeof vi.fn>; anchorNow: ReturnType<typeof vi.fn>; length: ReturnType<typeof vi.fn> }
function install(result: Record<string, unknown> = { ok: true, walked: 3, anchor, anchorMatchesWalkedHead: true },
  over: { length?: number | (() => Promise<number>); anchors?: () => Promise<ChainAnchorInfo[]>; project?: string } = {}): Bridge {
  const verify = vi.fn(async () => result)
  const anchorNow = vi.fn(async () => anchor)
  const length = vi.fn(typeof over.length === 'function' ? over.length : async () => (over.length as number | undefined) ?? 3)
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { count: vi.fn(async () => 0), onNewBatch: (cb: (e: unknown[]) => void) => { batches.add(cb); return () => batches.delete(cb) } },
    bookmarks: { list: vi.fn(async () => []) },
    project: { active: vi.fn(async () => ({ id: over.project ?? 'p1', name: 'demo' })) },
    chain: { anchors: vi.fn(over.anchors ?? (async () => [accepted])), length, verify, anchorNow, upgrade: vi.fn(async () => ({ upgraded: 0, scanned: 0 })) }
  }
  return { verify, anchorNow, length }
}

const mount = (page: 'screenshots' | 'loot' | 'bookmarks' = 'screenshots'): void => {
  render(<I18nProvider><EvidenceHeader page={page} onNavigate={vi.fn()} /></I18nProvider>)
}
const result = (): HTMLElement => screen.getByTestId('evidence-verify-result')
const verify = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Verify' }))
  await waitFor(() => expect(result().textContent).toMatch(/Verified/))
}
/** Open the block's disclosure (collapsed by default for a clean or absent result). */
const openDetails = (): HTMLElement => {
  const toggle = within(screen.getByTestId('evidence-verify-line')).getByRole('button', { name: 'Details' })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  return screen.getByTestId('evidence-verify-details')
}
const chainIssue = (): ReturnType<typeof snapshotIssues>[number] | undefined => snapshotIssues().find((i) => i.id === 'chain')

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); batches.clear(); _resetIssues(); setLastVerifyResult(null); vi.restoreAllMocks() })

describe('the verification block', () => {
  it('sits above the tabs on every evidence tab, with one primary Verify', async () => {
    for (const page of ['screenshots', 'loot', 'bookmarks'] as const) {
      install()
      mount(page)
      const header = screen.getByTestId('evidence-header')
      const block = within(header).getByTestId('evidence-verify')
      const tabs = within(header).getByRole('tablist')
      expect(block.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(within(block).getByRole('button', { name: 'Verify' }).className).toContain('bg-redlog-accent')
      cleanup()
    }
  })

  // §4: one primary per screen. With no screenshots, the empty state's
  // capture is the second verb on the page, so it steps down.
  it('stays the only primary on an Evidence page with no screenshots', async () => {
    install()
    ;(window.redlog.events as Record<string, unknown>).queryScreenshotPage = async () => ({ items: [], hasMore: false, nextCursor: null })
    render(<I18nProvider><EvidenceHeader page="screenshots" onNavigate={vi.fn()} /><ScreenshotsView /></I18nProvider>)
    await screen.findByText('Screenshots will appear here when captured')
    const primaries = screen.getAllByRole('button').filter((b) => b.className.includes('bg-redlog-accent '))
    expect(primaries.map((b) => b.textContent)).toEqual(['Verify'])
  })

  it('says "Not verified yet" when this run has no result, and shows no tick', async () => {
    install()
    mount()
    await waitFor(() => expect(result().textContent).toBe('Not verified yet'))
    expect(screen.getByTestId('evidence-verify').textContent).not.toContain('✓')
  })

  it('names when it verified, how many entries it walked, and the verdict', async () => {
    const { verify: walk } = install()
    mount()
    await verify()
    expect(result().textContent).toMatch(/Verified \d\d:\d\d:\d\d/)
    expect(result().textContent).toContain('✓ Chain intact')
    expect(result().textContent).toContain('Walked 3 events')
    expect(result().textContent).not.toContain('added since')
    expect(walk).toHaveBeenCalledTimes(1)
  })

  // Two green ticks beside an anchor that timestamped nothing.
  it('does not say the anchor matches when the anchor it was compared with failed', async () => {
    install(undefined, { anchors: async () => [anchor] })
    mount()
    await verify()
    const details = openDetails()
    expect(details.textContent).not.toContain('✓ Anchor matches the events it covers')
    expect(within(details).getByText(/The latest anchor was never accepted/).className).toContain('amber')
    expect(screen.getByTestId('evidence-verify-line').textContent).toContain('✗ The last anchor failed')
  })

  it('says the anchor matches when the anchor it was compared with was accepted', async () => {
    install({ ok: true, walked: 3, anchor: accepted, anchorMatchesWalkedHead: true }, { anchors: async () => [accepted] })
    mount()
    await verify()
    expect(within(openDetails()).getByText('✓ Anchor matches the events it covers')).toBeTruthy()
  })

  // The tick covers the entries walked, never the chain as it is now.
  it('says how many entries arrived after the walk and were not verified', async () => {
    install(undefined, { length: 1201 })
    mount()
    await waitFor(() => expect(window.redlog.chain.length).toHaveBeenCalled())
    act(() => { setLastVerifyResult({ ok: true, walked: 1201, anchor, anchorMatchesWalkedHead: true }, { projectId: 'p1' }) })
    await waitFor(() => expect(result().textContent).toContain('Walked 1,201 events'))
    expect(result().textContent).not.toContain('added since')
    // The chain grows while the page is open; the next read of its length says so.
    window.redlog.chain.length = vi.fn(async () => 1284)
    act(() => { for (const cb of batches) cb([{ id: 'e1285', agentType: 'command' }]) })
    await waitFor(() => expect(result().textContent).toContain('83 added since, not verified'), { timeout: 3000 })
    expect(result().textContent).toContain('Walked 1,201 events')
  })

  it('keeps the result when the page is left and come back to, on the same project', async () => {
    install()
    mount()
    await verify()
    cleanup()
    install()
    mount('loot')
    await waitFor(() => expect(result().textContent).toContain('Chain intact'))
  })

  it('does not show a result walked on another project', async () => {
    setLastVerifyResult({ ok: true, walked: 3, anchor, anchorMatchesWalkedHead: true }, { projectId: 'other' })
    install(undefined, { project: 'p1' })
    mount()
    await waitFor(() => expect(result().textContent).toBe('Not verified yet'))
  })

  it('raises the chain issue, pointed at the Evidence page, when the walk breaks', async () => {
    install({ ok: false, walked: 1, brokenAtEventId: 'e2', brokenReason: 'hash mismatch', anchor, anchorMatchesWalkedHead: false,
      signedCount: 1, unsignedCount: 0, noPubKeyCount: 0, authentication: 'failed', authenticationReasons: [] }, { length: 3 })
    mount()
    await verify()
    expect(result().textContent).toContain('✗ Chain broken')
    // A broken walk does not claim the rest of the chain as "added since".
    expect(result().textContent).not.toContain('added since')
    expect(screen.getByText(/Broken at event/).textContent).toContain('e2')
    // The walk counted signatures only up to the break; no count is offered as a result.
    expect(screen.getByTestId('evidence-verify-detail').textContent).not.toMatch(/Signatures/)
    await waitFor(() => expect(chainIssue()?.view).toBe('screenshots'))
  })

  // Rows re-hashed end to end, or cut short, still walk cleanly; only the
  // anchor disagrees. That is a broken chain too.
  it('does not head an anchor mismatch with "Chain intact", and raises the chain issue', async () => {
    install({ ok: true, walked: 3, anchor, anchorMatchesWalkedHead: false })
    mount()
    await verify()
    expect(result().textContent).not.toContain('Chain intact')
    expect(result().textContent).toContain('⚠ Anchor mismatch')
    expect(result().innerHTML).not.toContain('emerald')
    // The full sentence once, in the disclosure, which a verdict that is not clean opens.
    expect(within(screen.getByTestId('evidence-verify-details')).getAllByText(/Anchor does not match the events it covers/)).toHaveLength(1)
    expect(screen.getAllByText(/Anchor does not match the events it covers/)).toHaveLength(1)
    await waitFor(() => expect(chainIssue()).toBeTruthy())
  })

  it('does not head incomplete signatures with "Chain intact", and raises no chain issue', async () => {
    install({
      ok: true, walked: 3, anchor, anchorMatchesWalkedHead: true,
      signedCount: 2, unsignedCount: 1, noPubKeyCount: 0,
      authentication: 'failed', authenticationReasons: ['1 row has no signature'], firstUncheckedEventId: 'e3'
    })
    mount()
    await verify()
    expect(result().textContent).not.toContain('Chain intact')
    expect(result().textContent).toContain('Signatures incomplete')
    expect(result().textContent).not.toContain('✓')
    expect(screen.getByText('1 row has no signature')).toBeTruthy()
    expect(screen.getAllByText(/Signatures incomplete/)).toHaveLength(1)
    expect(chainIssue()).toBeUndefined()
  })

  it('clears the chain issue when the walk and the anchor agree', async () => {
    raiseIssue({ id: 'chain', tier: 'attention', title: 'x', detail: 'y', view: 'screenshots' })
    install()
    mount()
    await verify()
    expect(chainIssue()).toBeUndefined()
  })

  it('says when there was no anchor to check against', async () => {
    install({ ok: true, walked: 3, anchor: null })
    mount()
    await verify()
    expect(within(openDetails()).getByText('No anchor yet: only the rows were checked against each other.')).toBeTruthy()
  })

  it('keeps the button usable and says so when the walk cannot run', async () => {
    const { verify: walk } = install()
    walk.mockRejectedValueOnce(new Error('ipc down'))
    mount()
    const button = await screen.findByRole('button', { name: 'Verify' })
    fireEvent.click(button)
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect(result().textContent).toBe('Not verified yet')
  })
})

describe('what is known without verifying', () => {
  it('states the chain length and the latest anchor with what it leaves unanchored', async () => {
    install(undefined, { length: 5, anchors: async () => [accepted] })
    mount()
    const facts = within(openDetails()).getByTestId('evidence-chain-facts')
    await waitFor(() => expect(facts.textContent).toContain('5 events'))
    await waitFor(() => expect(facts.textContent).toContain('3 not anchored'))
    expect(facts.textContent).toContain('COMPLETE')
  })

  it('does not call a failed anchor "not anchored yet"', async () => {
    install(undefined, { anchors: async () => [anchorAt({ status: 'failed' })], length: 5 })
    mount()
    const details = openDetails()
    const facts = within(details).getByTestId('evidence-chain-facts')
    await waitFor(() => expect(details.textContent).toContain('The last anchor failed'))
    expect(details.textContent).not.toContain('Not anchored yet')
    // A failed submission timestamped nothing.
    expect(facts.textContent).toContain('5 not anchored')
  })

  it('says an anchor a day old is stale', async () => {
    install(undefined, { anchors: async () => [anchorAt({ createdAt: NOW - 50 * 3_600_000 })] })
    mount()
    await waitFor(() => expect(openDetails().textContent).toContain('No successful anchor for 2 days'))
  })

  it('does not read a failed anchor list as "no anchors"', async () => {
    install(undefined, { anchors: async () => { throw new Error('db locked') } })
    mount()
    const facts = within(openDetails()).getByTestId('evidence-chain-facts')
    await waitFor(() => expect(facts.textContent).toContain('Could not be read'))
    expect(facts.textContent).not.toContain('Not anchored yet')
  })

  it('says "Not anchored yet" only when there is no anchor', async () => {
    install(undefined, { anchors: async () => [] })
    mount()
    await waitFor(() => expect(within(openDetails()).getByTestId('evidence-chain-facts').textContent).toContain('Not anchored yet'))
  })

  // The latest anchor's head and receipts were unreachable, and a project
  // with one anchor showed no head hash or calendar anywhere.
  it('lists every anchor, newest first, with its head and each calendar pending or upgraded', async () => {
    const receipt = (calendar: string, over: Partial<CalendarReceiptInfo> = {}): CalendarReceiptInfo => ({ calendar, ok: true, submittedAt: NOW, ...over })
    const only = anchorAt({ id: 'a9', headHash: 'ab'.repeat(32), calendarReceipts: [receipt('https://a.example.org'), receipt('https://b.example.org', { upgraded: true }), receipt('https://c.example.org', { ok: false, error: 'timeout' })] })
    install(undefined, { anchors: async () => [only] })
    mount()
    const details = openDetails()
    await waitFor(() => expect(within(details).getAllByTestId('anchor-card')).toHaveLength(1))
    const card = within(details).getByTestId('anchor-card')
    expect(card.textContent).toContain('ab'.repeat(16))
    expect(card.textContent).toContain('a.example.org · pending')
    expect(card.textContent).toContain('b.example.org · upgraded')
    expect(card.textContent).toContain('c.example.org · failed')
    expect(details.textContent).toContain('Each calendar receipt can be checked independently with the `ots` CLI.')
  })

  it('lists all anchors, not all but the latest', async () => {
    install(undefined, { anchors: async () => [anchorAt({ id: 'a3' }), anchorAt({ id: 'a2', createdAt: NOW - 3_600_000 }), anchorAt({ id: 'a1', createdAt: NOW - 7_200_000 })] })
    mount()
    const details = openDetails()
    await waitFor(() => expect(within(details).getAllByTestId('anchor-card')).toHaveLength(3))
  })

  it('names the head the last walk ended on', async () => {
    install({ ok: true, walked: 3, anchor: accepted, anchorMatchesWalkedHead: true, currentHead: 'cd'.repeat(32) })
    mount()
    await verify()
    expect(openDetails().textContent).toContain(`Head at the last walk: ${'cd'.repeat(32)}`)
  })

  // Anchoring is not destructive and is not the page's verb.
  it('offers Anchor now and Upgrade after Verify, neither of them danger', async () => {
    const { anchorNow } = install()
    mount()
    openDetails()
    const block = screen.getByTestId('evidence-verify')
    const names = within(block).getAllByRole('button').map((b) => b.textContent)
    expect(names.indexOf('Verify')).toBeLessThan(names.indexOf('Anchor now'))
    for (const name of ['Anchor now', 'Upgrade pending']) {
      const b = within(block).getByRole('button', { name })
      expect(b.className).not.toContain('bg-redlog-danger')
      expect(b.className).not.toContain('bg-redlog-accent')
    }
    fireEvent.click(within(block).getByRole('button', { name: 'Anchor now' }))
    await waitFor(() => expect(anchorNow).toHaveBeenCalledTimes(1))
  })

  it('keeps an offline skip on the anchor line, not only in a toast', async () => {
    const { anchorNow } = install()
    anchorNow.mockResolvedValueOnce({ skipped: 'offline' })
    mount()
    fireEvent.click(within(openDetails()).getByRole('button', { name: 'Anchor now' }))
    await waitFor(() => expect(screen.getByTestId('evidence-verify-line').textContent).toContain('Skipped: this project is offline'))
  })
})
