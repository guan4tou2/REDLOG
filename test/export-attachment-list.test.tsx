// @vitest-environment jsdom
//
// #222: the evidence-bundle preview lists each file with the targets it is
// tied to, and unticking one resolves the plan again without it — so what is
// confirmed is exactly what was previewed.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'

const rows = (excluded: string[]): ExportAttachmentRow[] => [
  { id: 'casts/term-1.cast', kind: 'cast', bytes: 2048, targets: ['a.test', 'b.test'], attribution: 'cross-target', status: 'included', source: 't1' },
  { id: 'casts/term-2.cast', kind: 'cast', bytes: 10, targets: ['a.test'], attribution: 'target', status: 'included' },
  { id: 'screenshots/x.jpg', kind: 'screenshot', bytes: null, targets: ['a.test'], attribution: 'target', status: 'missing' }
].map((r) => (excluded.includes(r.id) ? { ...r, status: 'excluded-by-operator' as const } : r)) as ExportAttachmentRow[]

function plan(excluded: string[]): ResolvedExportPlan {
  return {
    id: `plan-${excluded.length}`, fingerprint: `fp${excluded.length}567890abcdef`, expiresAt: Date.now() + 1000,
    snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1_700_000_000_000 },
    scopeSnapshot: { targets: ['a.test'], excludeTargets: [], personalDomains: [] },
    capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: false, attachments: true },
    request: { format: 'bundle', subset: { kind: 'all' }, sharing: false, maskOutOfScope: true, scopeOnly: false, scrubPii: false, excludeAttachments: excluded },
    counts: {
      examined: 3, included: 3, excludedDoNotExport: 0, excludedPersonal: 0, excludedBlacklist: 0, maskedOutOfScope: 0, sanitized: 0,
      attachmentsIncluded: 2 - excluded.length, attachmentsMissing: 1, attachmentsUnattributed: 0,
      attachmentsExcludedByOperator: excluded.length, unsupported: 0
    },
    attachments: rows(excluded)
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('bundle preview: per-attachment selection (#222)', () => {
  it('lists each file with its targets, flags a cross-target cast, and re-resolves without an unticked one', async () => {
    const resolve = vi.fn(async (req: ExportRequest) => ({ ok: true as const, plan: plan(req.excludeAttachments ?? []) }))
    ;(window as unknown as { redlog: unknown }).redlog = { data: { resolveExportPlan: resolve, executeExportPlan: vi.fn() } }
    render(<I18nProvider><ExportMenu totalCount={3} /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Export'))
    fireEvent.click(screen.getByText('Evidence bundle (with verifier)'))

    const list = await screen.findByTestId('export-attachments')
    const cross = within(list).getByTestId('export-attachment-casts/term-1.cast')
    expect(cross.textContent).toContain('several targets: a.test, b.test')
    expect(list.textContent).toContain('never trimmed to scope')
    // A missing file cannot be chosen.
    expect((within(list).getByLabelText('screenshots/x.jpg') as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(within(list).getByLabelText('casts/term-1.cast'))
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ excludeAttachments: ['casts/term-1.cast'] })))
    const after = await screen.findByTestId('export-attachment-casts/term-1.cast')
    expect(after.getAttribute('data-status')).toBe('excluded-by-operator')
    expect((within(after).getByLabelText('casts/term-1.cast') as HTMLInputElement).checked).toBe(false)

    // Ticking it again puts it back.
    fireEvent.click(within(after).getByLabelText('casts/term-1.cast'))
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ excludeAttachments: [] })))
  })
})
