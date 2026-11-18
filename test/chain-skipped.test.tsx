// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as Array<{ message: string; opts: unknown }>)
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.push({ message, opts }) }
}))

import { EvidenceVerify } from '../src/renderer/src/components/EvidenceVerify'
import { anchorNowWithFeedback } from '../src/renderer/src/lib/chainActions'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues, snapshotIssues } from '../src/renderer/src/lib/issues'

// An air-gapped project does not submit an anchor. That is not "nothing to
// anchor" (an error) and not an anchor (a success, with receipts to count).
const SKIPPED = 'Skipped: this project is offline'

function install(chain: Record<string, unknown>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { onNewBatch: () => () => {} },
    project: { active: vi.fn(async () => ({ id: 'p1', name: 'demo' })) },
    chain: { anchors: vi.fn(async () => []), length: vi.fn(async () => 0), verify: vi.fn(), anchorNow: vi.fn(), upgrade: vi.fn(), ...chain }
  }
}

function Panel(): JSX.Element {
  return <EvidenceVerify heading={<h1>Evidence</h1>} />
}
/** Anchor now and Upgrade sit in the block's disclosure. */
const openDetails = async (): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name: 'Details' })) }

describe('air-gapped anchoring', () => {
  afterEach(() => { cleanup(); _resetIssues(); toasts.length = 0 })

  it('shows one neutral toast, raises no issue and returns null', async () => {
    install({ anchorNow: vi.fn(async () => ({ skipped: 'offline' })) })
    const t = (k: string): string => ({ 'settings.integritySkippedOffline': SKIPPED }[k] ?? k)
    expect(await anchorNowWithFeedback(t)).toBeNull()
    expect(toasts).toEqual([{ message: SKIPPED, opts: 'info' }])
    expect(snapshotIssues()).toEqual([])
  })

  it('Evidence ▸ verification: Anchor now does not show the "no anchors" error', async () => {
    install({ anchorNow: vi.fn(async () => ({ skipped: 'offline' })) })
    render(<I18nProvider><Panel /></I18nProvider>)
    await openDetails()
    fireEvent.click(screen.getByText('Anchor now'))
    await waitFor(() => expect(toasts.map((x) => x.message)).toEqual([SKIPPED]))
  })

  it('Evidence ▸ verification: upgrade does not read a skipped result as counts', async () => {
    // Upgrade shows only while a calendar receipt is pending.
    const pending = { id: 'a1', headEventId: 'e1', headHash: 'f'.repeat(64), eventCount: 1, status: 'complete', createdAt: Date.now(), completedAt: null,
      calendarReceipts: [{ calendar: 'https://a.example.org', ok: true, submittedAt: Date.now() }] }
    install({ upgrade: vi.fn(async () => ({ skipped: 'offline' })), anchors: vi.fn(async () => [pending]) })
    render(<I18nProvider><Panel /></I18nProvider>)
    await openDetails()
    fireEvent.click(await screen.findByText('Upgrade pending'))
    await waitFor(() => expect(toasts.map((x) => x.message)).toEqual([SKIPPED]))
  })
})
