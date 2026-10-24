// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'
import { useContributeExport, type ViewExport } from '../src/renderer/src/lib/exportScope'
import { capabilitiesFor } from '../src/core/export-capabilities'

const selection: ExportSubset = { kind: 'selection', projection: 'events', filter: { targetId: 'corp.test', since: 100, before: 200 }, query: 'needle', excludeHousekeeping: true }
const entry: ViewExport = { label: 'Search', request: { format: 'json', subset: selection } }
function View({ value }: { value: ViewExport }): null { useContributeExport(value); return null }
function plan(request: ExportRequest, id = 'latest'): ResolvedExportPlan {
  return {
    id, fingerprint: id, expiresAt: Date.now() + 60_000,
    request: { ...request, subset: request.subset ?? { kind: 'all' }, maskOutOfScope: !!request.maskOutOfScope, scrubPii: !!request.scrubPii, scopeOnly: false },
    scopeSnapshot: { targets: ['corp.test'], excludeTargets: [], personalDomains: [] },
    capabilities: capabilitiesFor(request.format), snapshot: { chainedMaxRowId: 500, loggedMaxRowId: 400, takenAt: 1000 },
    counts: { examined: 600, included: 600, excludedDoNotExport: 0, excludedPersonal: 0, maskedOutOfScope: 0, sanitized: 0, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
  }
}
let resolve: ReturnType<typeof vi.fn>
let execute: ReturnType<typeof vi.fn>
const open = (): void => { fireEvent.click(screen.getByLabelText('Export')) }
const format = (value: string): void => { fireEvent.change(screen.getByLabelText('Export format'), { target: { value } }) }
const range = (value: string): void => { fireEvent.change(screen.getByLabelText('Export range'), { target: { value } }) }
const ready = async (): Promise<void> => { await screen.findByTestId('export-confirm') }
function draw(value = entry): ReturnType<typeof render> {
  return render(<I18nProvider><View value={value} /><ExportMenu totalCount={600} /></I18nProvider>)
}

describe('one export dialog', () => {
  beforeEach(() => {
    localStorage.clear()
    resolve = vi.fn(async (request: ExportRequest) => ({ ok: true, plan: plan(request) }))
    execute = vi.fn(async () => ({ ok: true, artifactPath: '/tmp/artifact' }))
    ;(window as unknown as { redlog: unknown }).redlog = { data: { resolveExportPlan: resolve, executeExportPlan: execute } }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('opens directly with the complete contributed query, not loaded rows', async () => {
    draw(); open(); await ready()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(resolve.mock.calls[0][0]).toMatchObject({ format: 'json', subset: selection })
    expect(screen.getByTestId('export-preview-subset').textContent).toContain('needle')
    expect(screen.getAllByText('600')).toHaveLength(2)
  })
  it('changes format without changing range, and all-project range without changing format', async () => {
    draw(); open(); await ready()
    format('ndjson'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'ndjson', subset: selection })
    range('all'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'ndjson', subset: { kind: 'all' } })
    format('bundle'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'bundle', subset: { kind: 'all' } })
    range('current'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'bundle', subset: selection })
  })
  it('freezes the view query until the dialog is closed and opened again', async () => {
    const ui = draw(); open(); await ready()
    const next = { ...entry, request: { ...entry.request, subset: { ...selection, query: 'other' } as ExportSubset } }
    ui.rerender(<I18nProvider><View value={next} /><ExportMenu totalCount={600} /></I18nProvider>)
    format('ndjson'); await ready()
    expect(resolve.mock.lastCall?.[0].subset).toEqual(selection)
    fireEvent.keyDown(window, { key: 'Escape' }); open(); await ready()
    expect(resolve.mock.lastCall?.[0].subset).toEqual(next.request.subset)
  })
  it('preserves HTTP predicates and uses HAR without claiming unsupported masking', async () => {
    const subset: ExportSubset = { kind: 'selection', projection: 'http', filter: { targetId: 'corp.test' }, http: { method: 'POST', statusPrefix: '4', text: 'login' } }
    draw({ label: 'HTTP', request: { format: 'har', subset } }); open(); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'har', subset, maskOutOfScope: false, scrubPii: false })
    const mask = screen.getByLabelText(/mask out-of-scope content using web scope/i) as HTMLInputElement
    expect(mask.disabled).toBe(true)
    expect(mask.checked).toBe(false)
    expect(screen.getByTestId('export-preview-policy').textContent).not.toContain('out-of-scope masked')
    format('json'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'json', subset, maskOutOfScope: true })
  })
  it('retains the timeline format supplied by the view', async () => {
    draw({ label: 'Timeline', request: { format: 'timeline', subset: selection } }); open(); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'timeline', subset: selection })
    range('all'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'timeline', subset: { kind: 'all' } })
  })
  it('does not silently disable PII policy to select a format that cannot scrub', async () => {
    draw(); open(); await ready()
    fireEvent.click(screen.getByLabelText(/scrub operator pii/i)); await ready()
    expect((screen.getByRole('option', { name: /Evidence bundle/ }) as HTMLOptionElement).disabled).toBe(true)
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'json', scrubPii: true, subset: selection })
  })
  it('discards stale previews and cannot confirm while the new request is unresolved', async () => {
    const pending: Array<(value: ExportPlanResponse) => void> = []
    resolve.mockImplementation(() => new Promise(r => pending.push(r)))
    draw(); open()
    const first = resolve.mock.calls[0][0] as ExportRequest
    format('bundle')
    const second = resolve.mock.calls[1][0] as ExportRequest
    expect(screen.queryByTestId('export-confirm')).toBeNull()
    pending[1]({ ok: true, plan: plan(second, 'second') }); await ready()
    pending[0]({ ok: true, plan: plan(first, 'first') })
    await waitFor(() => expect(screen.queryByText('first')).toBeNull())
    fireEvent.click(screen.getByTestId('export-confirm'))
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ planId: 'second' }))
  })
  it('cancel closes the dialog in one action and late replies cannot reopen it', async () => {
    let release!: (value: ExportPlanResponse) => void
    resolve.mockImplementation(() => new Promise(r => { release = r }))
    draw(); open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    release({ ok: true, plan: plan({ format: 'json', subset: selection }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(execute).not.toHaveBeenCalled()
  })
  it('keeps attachment exclusions when changing format and range', async () => {
    resolve.mockImplementation(async (request: ExportRequest) => {
      const p = plan(request)
      if (request.format === 'bundle') p.attachments = [{ id: 'casts/session.cast', kind: 'cast', bytes: 42, targets: [], attribution: 'unattributed', status: request.excludeAttachments?.includes('casts/session.cast') ? 'excluded-by-operator' : 'included' }]
      return { ok: true, plan: p }
    })
    draw(); open(); await ready(); format('bundle'); await ready()
    fireEvent.click(screen.getByLabelText('casts/session.cast')); await ready()
    format('ndjson'); await ready(); range('all'); await ready(); format('bundle'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'bundle', subset: { kind: 'all' }, excludeAttachments: ['casts/session.cast'] })
    expect((screen.getByLabelText('casts/session.cast') as HTMLInputElement).checked).toBe(false)
  })
  it('allows all-project export when the current view cannot be exported', async () => {
    draw({ ...entry, disabledReason: 'This query cannot be exported' }); open()
    expect(screen.getByRole('alert').textContent).toContain('This query cannot be exported')
    expect(resolve).not.toHaveBeenCalled()
    range('all'); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ subset: { kind: 'all' } })
  })
  it('locks edits and cancellation during execution, then keeps the draft after failure', async () => {
    let release!: (value: { ok: boolean; error: string }) => void
    execute.mockImplementation(() => new Promise(r => { release = r }))
    draw(); open(); await ready(); format('ndjson'); await ready()
    fireEvent.click(screen.getByTestId('export-confirm'))
    expect((screen.getByLabelText('Export format') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Export range') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    release({ ok: false, error: 'disk full' })
    await screen.findByTestId('export-run-error')
    expect((screen.getByLabelText('Export format') as HTMLSelectElement).value).toBe('ndjson')
    expect((screen.getByTestId('export-confirm') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Recalculate and try again')); await ready()
    expect(resolve.mock.lastCall?.[0]).toMatchObject({ format: 'ndjson', subset: selection })
  })

})
