// @vitest-environment jsdom
//
// What the export dialog opens on, what it says once, and which formats it
// offers — found in a full-flow walk in a real window:
//   A. a project the operator has not narrowed opened on "current results",
//      so the default deliverable was labelled partial evidence;
//   B. "Hide personal traffic" was said twice, and a format that cannot scrub
//      PII showed a disabled checkbox plus a sentence saying so;
//   C. HAR was offered only from the HTTP page.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'
import { useContributeExport, type ViewExport } from '../src/renderer/src/lib/exportScope'
import { capabilitiesFor } from '../src/core/export-capabilities'

type Subset = NonNullable<ExportRequest['subset']>
const SNAP = { chainedMaxRowId: 1, loggedMaxRowId: 1, chainedCount: 1, loggedCount: 1, chainedTailId: 'a', loggedTailId: null, takenAt: 1 }
// The shared filter's default state, as `toEventFilter` sends it.
const DEFAULT_FILTER = { hidePersonal: true }

function View({ value }: { value: ViewExport }): null { useContributeExport(value); return null }
function plan(request: ExportRequest): ResolvedExportPlan {
  return {
    id: 'p', fingerprint: `fp-${request.subset?.kind ?? 'all'}`, expiresAt: Date.now() + 60_000,
    request: { ...request, subset: request.subset ?? { kind: 'all' }, maskOutOfScope: !!request.maskOutOfScope, scrubPii: !!request.scrubPii, scopeOnly: false },
    scopeSnapshot: { targets: ['corp.test'], excludeTargets: [], personalDomains: [] },
    capabilities: capabilitiesFor(request.format), snapshot: { chainedMaxRowId: 5, loggedMaxRowId: 4, takenAt: 1000 },
    counts: { ...(request.format === 'har' ? { exchanges: 7 } : {}), examined: 9, included: 9, excludedDoNotExport: 0, excludedPersonal: 0, maskedOutOfScope: 0, sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
  }
}
let resolve: ReturnType<typeof vi.fn>
const open = (): void => { fireEvent.click(screen.getByLabelText('Export')) }
const ready = async (): Promise<void> => { await screen.findByTestId('export-confirm') }
const rangeValue = (): string => (screen.getByLabelText('Export range') as HTMLSelectElement).value
const format = (value: string): void => {
  const secondary = value !== 'bundle'
  fireEvent.change(screen.getByLabelText('Export format'), { target: { value: secondary ? 'other' : value } })
  if (secondary) fireEvent.change(screen.getByLabelText('Other formats'), { target: { value } })
}
function draw(value?: ViewExport): void {
  render(<I18nProvider>{value && <View value={value} />}<ExportMenu totalCount={9} /></I18nProvider>)
}

beforeEach(() => {
  localStorage.clear()
  resolve = vi.fn(async (request: ExportRequest) => ({ ok: true, plan: plan(request) }))
  ;(window as unknown as { redlog: unknown }).redlog = { data: { recentExport: vi.fn(async () => ({ ok: true, delivery: null })), resolveExportPlan: resolve, executeExportPlan: vi.fn() } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('A. the dialog opens on the whole project unless the operator narrowed the view', () => {
  it('opens on the entire project from a page with no filter, resolving that plan once and no other', async () => {
    draw(); open(); await ready()
    expect(rangeValue()).toBe('all')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toMatchObject({ subset: { kind: 'all' } })
    expect(screen.queryByTestId('export-projection-notice')).toBeNull()
    expect(screen.getByText('fp-all')).toBeTruthy()
  })
  it('opens on the entire project from the HTTP page with an empty filter box', async () => {
    draw({ label: 'HTTP', request: { format: 'har', subset: { kind: 'selection', projection: 'http', filter: DEFAULT_FILTER, http: { text: '' } } } })
    open(); await ready()
    expect(rangeValue()).toBe('all')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toMatchObject({ format: 'har', subset: { kind: 'all' } })
  })
  it('opens on the current results when the view is narrowed, resolving once', async () => {
    const subset: Subset = { kind: 'selection', projection: 'events', filter: { ...DEFAULT_FILTER, targetId: 'corp.test' }, query: '' }
    draw({ label: 'Search', request: { format: 'json', subset } }); open(); await ready()
    expect(rangeValue()).toBe('current')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toMatchObject({ subset })
  })
  it('keeps an exported session as its own subset', async () => {
    const subset: Subset = { kind: 'session', projectId: 'p', anchorEventId: 'e', snapshot: SNAP }
    draw({ label: 'Session', request: { format: 'json', subset } }); open(); await ready()
    expect(rangeValue()).toBe('current')
    expect(resolve.mock.calls[0][0]).toMatchObject({ subset })
  })
  it('keeps the operator\'s range when the plan re-resolves', async () => {
    draw(); open(); await ready()
    fireEvent.change(screen.getByLabelText('Export range'), { target: { value: 'current' } }); await ready()
    format('ndjson'); await ready()
    expect(rangeValue()).toBe('current')
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'ndjson', subset: { kind: 'selection' } })
  })
})

describe('B. each fact said once', () => {
  it('names hiding personal traffic only in the selection summary', async () => {
    draw(); open(); await ready()
    fireEvent.change(screen.getByLabelText('Export range'), { target: { value: 'current' } }); await ready()
    const dialog = screen.getByRole('dialog').textContent ?? ''
    expect(dialog.split('Hide personal traffic').length - 1).toBe(1)
    expect(screen.getByTestId('export-preview-subset').textContent).toContain('Hide personal traffic')
  })
  it('says the current filter is not applied only when there is one to not apply', async () => {
    draw(); open(); await ready()
    expect(screen.queryByText('The whole project; the current filter is not applied')).toBeNull()
    cleanup()
    draw({ label: 'Search', request: { format: 'json', subset: { kind: 'selection', projection: 'events', filter: { targetId: 'corp.test' } } } })
    open(); await ready()
    fireEvent.change(screen.getByLabelText('Export range'), { target: { value: 'all' } }); await ready()
    expect(screen.getByText('The whole project; the current filter is not applied')).toBeTruthy()
  })
  it('shows no PII control for a format that cannot scrub, and no sentence about it', async () => {
    draw(); open(); await ready()
    expect((screen.getByLabelText('Export format') as HTMLSelectElement).value).toBe('bundle')
    expect(screen.queryByLabelText(/scrub operator pii/i)).toBeNull()
    expect(screen.queryByText('This format cannot scrub PII')).toBeNull()
    format('json'); await ready()
    expect(screen.getByLabelText(/scrub operator pii/i)).toBeTruthy()
  })
  it('never asks a format that cannot scrub to scrub, and the plan says nothing was scrubbed', async () => {
    draw(); open(); await ready()
    format('json'); await ready()
    fireEvent.click(screen.getByLabelText(/scrub operator pii/i)); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'json', scrubPii: true })
    format('bundle'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'bundle', scrubPii: false })
    expect(screen.getByTestId('export-preview-policy').textContent).not.toContain('PII scrubbed')
    format('json'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'json', scrubPii: true })
  })
})

describe('C. HAR is offered on every page', () => {
  it('offers HAR under the other formats from a page that is not the HTTP page, with the exchange count', async () => {
    draw(); open(); await ready()
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'other' } }); await ready()
    const other = screen.getByLabelText('Other formats') as HTMLSelectElement
    expect([...other.options].map(o => o.value)).toContain('har')
    fireEvent.change(other, { target: { value: 'har' } }); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'har', subset: { kind: 'all' } })
    expect(screen.getByText('HTTP exchanges: 7')).toBeTruthy()
  })
  it('does not offer HAR for an activity or a session, which it cannot carry', async () => {
    draw({ label: 'Session', request: { format: 'json', subset: { kind: 'session', projectId: 'p', anchorEventId: 'e', snapshot: SNAP } } })
    open(); await ready()
    fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'other' } }); await ready()
    const other = screen.getByLabelText('Other formats') as HTMLSelectElement
    await waitFor(() => expect([...other.options].map(o => o.value)).not.toContain('har'))
  })
})
