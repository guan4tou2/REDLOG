// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IntegrityPanel from '../src/renderer/src/components/settings/IntegrityPanel'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'
import { _resetIssues, raiseIssue, snapshotIssues } from '../src/renderer/src/lib/issues'

const anchor: ChainAnchorInfo = {
  id: 'a1', headEventId: 'e2', headHash: 'f'.repeat(64), eventCount: 2,
  calendarReceipts: [], status: 'failed', createdAt: 1_700_000_000_000, completedAt: null
}

function install(result: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const verify = vi.fn(async () => result)
  ;(window as unknown as { redlog: unknown }).redlog = {
    chain: { anchors: vi.fn(async () => [anchor]), verify, anchorNow: vi.fn(), upgrade: vi.fn() }
  }
  return verify
}

function Panel(): JSX.Element {
  const { t } = useI18n()
  return <IntegrityPanel t={t} />
}

const chainIssue = (): boolean => snapshotIssues().some((i) => i.id === 'chain')

// There were two verify buttons: one compared the latest anchor, one walked
// the chain and also checked the anchor. Only the lesser one raised the
// broken-chain issue, so the check that found a broken row never said so
// anywhere but its own card.
describe('Integrity verify', () => {
  afterEach(() => { cleanup(); _resetIssues(); vi.restoreAllMocks() })

  it('offers one verify, and it walks the whole chain', async () => {
    const verify = install({ ok: true, walked: 3, anchor, anchorMatchesWalkedHead: true, currentHead: 'a'.repeat(64) })
    render(<I18nProvider><Panel /></I18nProvider>)
    expect(screen.queryByText('Verify latest')).toBeNull()
    fireEvent.click(screen.getByText('Verify full chain'))
    await screen.findByText('Chain intact')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('raises the chain issue when the walk breaks', async () => {
    install({ ok: false, walked: 1, brokenAtEventId: 'e2', brokenReason: 'hash mismatch', anchor, anchorMatchesWalkedHead: false })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Verify full chain'))
    await waitFor(() => expect(chainIssue()).toBe(true))
  })

  // Rows re-hashed end to end, or cut short, still walk cleanly; only the
  // anchor disagrees. That is a broken chain too.
  it('raises the chain issue when the rows walk but the anchor does not match', async () => {
    install({ ok: true, walked: 3, anchor, anchorMatchesWalkedHead: false })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Verify full chain'))
    await waitFor(() => expect(chainIssue()).toBe(true))
  })

  it('clears the chain issue when the walk and the anchor agree', async () => {
    raiseIssue({ id: 'chain', tier: 'attention', title: 'x', detail: 'y', view: 'settings' })
    install({ ok: true, walked: 3, anchor, anchorMatchesWalkedHead: true })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Verify full chain'))
    await screen.findByText('Chain intact')
    expect(chainIssue()).toBe(false)
  })

  it('says when there is no anchor to check against', async () => {
    install({ ok: true, walked: 3, anchor: null })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Verify full chain'))
    await screen.findByText('No anchor yet: only the rows were checked against each other.')
  })
})
