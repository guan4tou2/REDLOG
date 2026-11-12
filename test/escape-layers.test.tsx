// @vitest-environment jsdom
//
// One Escape closes one layer. Every dialog below listened for Escape on the
// window, and so did the Timeline inspector behind them, so one press with the
// Export dialog (or a confirm, or the marker dialog) open over an open
// inspector closed both. The replay drawer closed on any Escape anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { ConfirmDialogContainer, confirm } from '../src/renderer/src/components/ConfirmDialog'
import EventMarker from '../src/renderer/src/components/EventMarker'
import { ReplayDrawer } from '../src/renderer/src/components/ReplayDrawer'
import { Modal } from '../src/renderer/src/components/Modal'
import { replayStore } from '../src/renderer/src/lib/replayStore'
import { capabilitiesFor } from '../src/core/export-capabilities'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

vi.mock('../src/renderer/src/components/SessionReplayPlayer', () => ({ SessionReplayPlayer: () => <div data-testid="replay-player" /> }))

const T0 = 1_700_000_000_000
const dots = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-event]'))
const bar = (): HTMLElement | null => screen.queryByTestId('timeline-detail-panel')
const body = (): HTMLElement | null => screen.queryByTestId('timeline-detail-body')
const esc = (): void => { fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' }) }

function plan(request: ExportRequest): ResolvedExportPlan {
  return {
    id: 'p', fingerprint: 'p', expiresAt: Date.now() + 60_000,
    request: { ...request, subset: request.subset ?? { kind: 'all' }, maskOutOfScope: !!request.maskOutOfScope, scrubPii: !!request.scrubPii, scopeOnly: false },
    scopeSnapshot: { targets: [], excludeTargets: [], personalDomains: [] },
    capabilities: capabilitiesFor(request.format), snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1 },
    counts: { examined: 1, included: 1, excludedDoNotExport: 0, excludedPersonal: 0, maskedOutOfScope: 0, sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
  }
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  const b = installTimelineBridge()
  b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 1000), makeEvent('e2', T0)]))
  const r = window.redlog as unknown as Record<string, unknown>
  r.data = {
    recentExport: vi.fn(async () => ({ ok: true, delivery: null })),
    resolveExportPlan: vi.fn(async (request: ExportRequest) => ({ ok: true, plan: plan(request) })),
    executeExportPlan: vi.fn()
  }
  r.cdp = { getTab: vi.fn(async () => null) }
  r.marker = { create: vi.fn() }
  r.screenshot = { capture: vi.fn() }
})
afterEach(() => { replayStore.close(); cleanup() })

/** The Timeline with an event selected and its inspector body open. */
async function inspectorOpen(extra: JSX.Element | null = null): Promise<ReturnType<typeof render>> {
  const ui = render(<I18nProvider><FilterProvider><TimelinePanel />{extra}</FilterProvider></I18nProvider>)
  await waitFor(() => expect(dots()).toHaveLength(2))
  fireEvent.click(dots()[0], { detail: 1 })
  fireEvent.doubleClick(dots()[0])
  await waitFor(() => expect(body()).not.toBeNull())
  return ui
}

describe('one Escape closes one layer', () => {
  it('Export over the inspector', async () => {
    await inspectorOpen(<ExportMenu totalCount={2} />)
    fireEvent.click(screen.getByLabelText('Export'))
    await screen.findByTestId('export-confirm')
    esc()
    await waitFor(() => expect(screen.queryByTestId('export-confirm')).toBeNull())
    expect(body()).not.toBeNull()
    esc()
    await waitFor(() => expect(body()).toBeNull())
    expect(bar()).not.toBeNull()
  })

  it('a confirm over the inspector', async () => {
    await inspectorOpen(<ConfirmDialogContainer />)
    let answer: boolean | null = null
    void act(() => { void confirm('Delete?', 'Really.').then((v) => { answer = v }) })
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    esc()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(answer).toBe(false)
    expect(body()).not.toBeNull()
    esc()
    await waitFor(() => expect(body()).toBeNull())
  })

  it('the marker dialog over the inspector, with and without a draft', async () => {
    const onClose = vi.fn()
    const ui = await inspectorOpen(<EventMarker onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true))
    // Escape is pressed with focus on one of the dialog's buttons, not in its
    // title field: the Timeline ignores every key typed into a field, so an
    // Escape from there never reached it and this case passed with both
    // layers removed.
    const onButton = (): void => {
      const button = screen.getByRole('dialog').querySelector('button')!
      act(() => { button.focus() })
      expect(document.activeElement).toBe(button)
      esc()
    }
    // A typed draft is kept — and that Escape must not fall through to the inspector either.
    fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: 'draft' } })
    onButton()
    expect(onClose).not.toHaveBeenCalled()
    expect(body()).not.toBeNull()
    fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: '' } })
    onButton()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(body()).not.toBeNull()
    // The dialog's owner unmounts it; the next Escape is the inspector's.
    ui.rerender(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    esc()
    await waitFor(() => expect(body()).toBeNull())
  })

  it('the replay drawer under a dialog closes on the second Escape, not the first', async () => {
    function Harness({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
      return <I18nProvider><ReplayDrawer /><Modal open={open} onClose={onClose} label="top"><button type="button">x</button></Modal></I18nProvider>
    }
    let open = true
    const close = vi.fn(() => { open = false })
    const ui = render(<Harness open={open} onClose={close} />)
    act(() => { replayStore.open({ events: [], truncated: false }) })
    expect(screen.getByTestId('replay-player')).toBeTruthy()
    esc()
    expect(close).toHaveBeenCalledTimes(1)
    ui.rerender(<Harness open={open} onClose={close} />)
    expect(screen.getByTestId('replay-player')).toBeTruthy()
    esc()
    expect(screen.queryByTestId('replay-player')).toBeNull()
  })

  it('the replay drawer leaves an Escape that a layer above already answered', async () => {
    render(<I18nProvider><ReplayDrawer /><input data-testid="owner" onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault() }} /></I18nProvider>)
    act(() => { replayStore.open({ events: [], truncated: false }) })
    fireEvent.keyDown(screen.getByTestId('owner'), { key: 'Escape' })
    expect(screen.getByTestId('replay-player')).toBeTruthy()
  })
})
