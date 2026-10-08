// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardIssues } from '../src/renderer/src/components/DashboardIssues'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues, raiseIssue } from '../src/renderer/src/lib/issues'
import { RECOUNT_EVENT } from '../src/renderer/src/lib/useAppCounts'

// The store has carried everything this panel shows since §9 — the tier, the
// route, how long the condition has been true — and rendered none of it: two
// counters in an 8px strip, with the rest in a `title` attribute.

const anchor: ChainAnchorInfo = {
  id: 'a1', headEventId: 'e2', headHash: 'f'.repeat(64), eventCount: 2,
  calendarReceipts: [{ url: 'https://cal.example', ok: true }], status: 'complete',
  createdAt: 1_700_000_000_000, completedAt: null
} as unknown as ChainAnchorInfo

function install(): { anchorNow: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } {
  const anchorNow = vi.fn(async () => anchor)
  const verify = vi.fn(async () => ({ ok: true, anchor: null, currentHead: null }))
  ;(window as unknown as { redlog: unknown }).redlog = { chain: { anchorNow, verify } }
  return { anchorNow, verify }
}

const show = (onNavigate = (): void => {}): void => {
  render(<I18nProvider><DashboardIssues onNavigate={onNavigate} /></I18nProvider>)
}

describe('DashboardIssues', () => {
  afterEach(() => { cleanup(); _resetIssues(); vi.restoreAllMocks() })

  it('renders nothing while nothing is wrong', () => {
    install()
    show()
    expect(screen.queryByTestId('dashboard-issues')).toBeNull()
  })

  it('prints what the status bar could only put in a tooltip', () => {
    install()
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture is dark', detail: 'Nothing has fed events', view: 'dashboard' })
    show()
    expect(screen.getByText('Capture is dark')).toBeTruthy()
    expect(screen.getByText('Nothing has fed events')).toBeTruthy()
    expect(screen.getByTestId('dashboard-issue-capture').dataset.tier).toBe('attention')
  })

  it('offers the act that answers the condition, where there is one', async () => {
    const { anchorNow } = install()
    raiseIssue({
      id: 'integrity', tier: 'attention', title: 'No anchor for 2 days',
      view: 'settings:integrity', fix: 'anchor-now'
    })
    show()
    fireEvent.click(screen.getByTestId('dashboard-issue-fix-integrity'))
    await waitFor(() => expect(anchorNow).toHaveBeenCalledTimes(1))
  })

  it('asks every surface to re-read, not just the one the button is on', async () => {
    // The dashboard's old scope-retry refreshed the dashboard's own copy of
    // the counts and left the status bar amber — the same read, two answers,
    // and the stale one was the surface the operator had not just corrected.
    install()
    const heard = vi.fn()
    window.addEventListener(RECOUNT_EVENT, heard)
    raiseIssue({
      id: 'scope', tier: 'attention', title: 'Scope state could not be read',
      view: 'settings:scope', fix: 'recheck-scope'
    })
    show()
    fireEvent.click(screen.getByTestId('dashboard-issue-fix-scope'))
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
    window.removeEventListener(RECOUNT_EVENT, heard)
  })

  it('offers no fix button for a condition no single act answers', () => {
    install()
    raiseIssue({ id: 'capture', tier: 'attention', title: 'Capture is dark', view: 'dashboard' })
    show()
    expect(screen.queryByTestId('dashboard-issue-fix-capture')).toBeNull()
  })

  it('routes to where the condition is dealt with', () => {
    install()
    const onNavigate = vi.fn()
    raiseIssue({ id: 'integrity', tier: 'attention', title: 'Chain drifted', view: 'settings:integrity' })
    show(onNavigate)
    fireEvent.click(screen.getByText('Open'))
    expect(onNavigate).toHaveBeenCalledWith('settings:integrity')
  })

  it('keeps the store’s order — attention above pending', () => {
    install()
    raiseIssue({ id: 'later', tier: 'pending', title: 'Pending one' })
    raiseIssue({ id: 'sooner', tier: 'attention', title: 'Attention one' })
    show()
    const rows = screen.getByTestId('dashboard-issues').querySelectorAll('[data-testid^="dashboard-issue-"]')
    expect([...rows].map((r) => (r as HTMLElement).dataset.tier)).toEqual(['attention', 'pending'])
  })
})
