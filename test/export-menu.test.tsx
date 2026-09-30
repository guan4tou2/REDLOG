// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'

function plan(included: number): ResolvedExportPlan {
  return {
    id: 'plan-1', fingerprint: '1234567890abcdef', expiresAt: Date.now() + 1000,
    snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1_700_000_000_000 },
    scopeSnapshot: { targets: ['10.0.0.0/24'], excludeTargets: [], personalDomains: [] },
    capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: true, attachments: false },
    request: { format: 'json', subset: { kind: 'all' }, sharing: true, maskOutOfScope: true, scopeOnly: false, scrubPii: true },
    counts: {
      examined: included, included, excludedDoNotExport: 0, excludedPersonal: 0,
      excludedBlacklist: 0, maskedOutOfScope: 0, sanitized: 0,
      attachmentsIncluded: 0, attachmentsMissing: 0,
      attachmentsUnattributed: 0, unsupported: 0
    }
  }
}

function install(resolveExportPlan: (request: ExportRequest) => Promise<ExportPlanResponse>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: {
      resolveExportPlan,
      executeExportPlan: vi.fn(async () => ({ ok: true, planId: 'plan-1', fingerprint: 'x', artifactPath: '/tmp/x', counts: plan(1).counts, warnings: [] }))
    }
  }
}

function openJson(): void {
  fireEvent.click(screen.getByLabelText('Export'))
  fireEvent.click(screen.getByText('Everything'))
}

describe('ExportMenu plan preview', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  // The evidence bundle cannot scrub operator PII, so the plan resolver
  // refuses the pair (unsupported-policy). The menu must not offer it as if it
  // would work.
  it('does not offer a format that cannot scrub PII once scrubbing is on', () => {
    install(vi.fn())
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Export'))
    const bundle = (): HTMLButtonElement | null => screen.getByText('Evidence bundle (with verifier)').closest('button')
    expect(bundle()?.disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/scrub operator pii/i))
    expect(bundle()?.disabled).toBe(true)
    expect(screen.getByText('Everything').closest('button')?.disabled).toBe(false)
  })

  it('keeps confirmation disabled for an empty approved selection', async () => {
    install(async () => ({ ok: true, plan: plan(0) }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    await screen.findByText('Plan fingerprint')
    const confirm = screen.getAllByText('Export').find((node) => node.closest('button')?.classList.contains('bg-red-600'))
    expect(confirm?.closest('button')?.disabled).toBe(true)
  })

  it('exposes loading and approved policy/selection details', async () => {
    let release: ((value: ExportPlanResponse) => void) | undefined
    install(() => new Promise((resolve) => { release = resolve }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    expect(screen.getByText('Calculating…')).toBeTruthy()
    release?.({ ok: true, plan: plan(3) })
    await waitFor(() => expect(screen.getByText('Entire approved snapshot')).toBeTruthy())
    // The policy line names each decision. It used to lead with the preset
    // word ("For sharing"), which told the operator which button had been
    // pressed rather than what the file would contain -- and the preset's own
    // description was wrong about two of the three things it claimed.
    const policy = screen.getByTestId('export-preview-policy').textContent ?? ''
    expect(policy).not.toContain('For sharing')
    expect(policy).toContain('out-of-scope masked')
    expect(policy).toContain('PII scrubbed')
    // And the boundary it was resolved against, which the menu used to
    // hardcode as `hasScope: false`.
    expect(screen.getByTestId('export-preview-scope').textContent).toContain('10.0.0.0/24')
    expect(screen.getByText('1234567890ab')).toBeTruthy()
    expect(screen.getByText('Data snapshot')).toBeTruthy()
  })
})

// UI/UX audit F12: the preview is a dialog, a failed run keeps it, and a
// finished export can be shown in its folder.
describe('ExportMenu as a dialog', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('opens the preview as a modal dialog', async () => {
    install(async () => ({ ok: true, plan: plan(2) }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('keeps the dialog and its preview when the run fails, and offers to recalculate', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, plan: plan(2) }))
    install(resolve)
    ;(window as unknown as { redlog: { data: Record<string, unknown> } }).redlog.data.executeExportPlan =
      vi.fn(async () => ({ ok: false, error: 'disk full' }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    fireEvent.click(await screen.findByTestId('export-confirm'))
    const err = await screen.findByTestId('export-run-error')
    expect(err.textContent).toContain('disk full')
    expect(screen.getByRole('dialog').textContent).toContain('Plan fingerprint')
    // Confirming again would reuse a spent plan; the way on is to recalculate.
    expect((screen.getByTestId('export-confirm') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Recalculate and try again'))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('export-run-error')).toBeNull())
  })

  it('closes on success', async () => {
    install(async () => ({ ok: true, plan: plan(2) }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    fireEvent.click(await screen.findByTestId('export-confirm'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
