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
    request: { format: 'json', subset: { kind: 'all' }, maskOutOfScope: true, scopeOnly: false, scrubPii: true },
    counts: {
      examined: included, included, excludedDoNotExport: 0, excludedPersonal: 0,
      maskedOutOfScope: 0, sanitized: 0,
      attachmentsIncluded: 0, attachmentsMissing: 0,
      attachmentsUnattributed: 0, unsupported: 0
    }
  }
}

function install(resolveExportPlan: (request: ExportRequest) => Promise<ExportPlanResponse>): void {
  localStorage.setItem('redlog.export.format', 'json')
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: {
      recentExport: vi.fn(async () => ({ ok: true, delivery: null })),
      revealExport: vi.fn(async () => true),
      resolveExportPlan,
      executeExportPlan: vi.fn(async () => ({ ok: true, planId: 'plan-1', fingerprint: 'x', artifactPath: '/tmp/x', counts: plan(1).counts, warnings: [], delivery: { artifactPath: '/tmp/x', format: 'json', completedAt: 1700000000000, availability: 'available' } }))
    }
  }
}

function openJson(): void {
  fireEvent.click(screen.getByLabelText('Export'))
  fireEvent.change(screen.getByLabelText('Export range'), { target: { value: 'all' } })
}

describe('ExportMenu plan preview', () => {
  it('keeps JSON chain/scope warnings without attachment instructions', async () => {
    const selected = plan(2)
    selected.request.subset = { kind: 'selection', projection: 'events', filter: {} }
    install(async () => ({ ok: true, plan: selected }))
    const { container } = render(<I18nProvider><ExportMenu totalCount={2} /></I18nProvider>)
    openJson()
    await screen.findByTestId('export-commands-note')
    expect(screen.getByTestId('export-preview-no-attachments').textContent).toContain('Attachments')
    expect(screen.getByTestId('export-projection-notice').textContent).toContain('not proof of the complete source chain')
    expect(container.textContent).not.toMatch(/attachments are chosen individually|Entire recording attachments|HTTP bodies/)
    expect(screen.getByTestId('export-commands-note').textContent).toContain('not filtered by web scope')
  })

  afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

  it('keeps confirmation disabled for an empty approved selection', async () => {
    install(async () => ({ ok: true, plan: plan(0) }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    await screen.findByText('Plan fingerprint')
    const confirm = screen.getByTestId('export-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
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

  // Spec 060 FR-009: masking an empty scope masks nothing, and the preview
  // must not say it did while also saying the web traffic is unfiltered.
  it('does not claim out-of-scope masking when no web scope is set', async () => {
    const empty = plan(3)
    install(async () => ({ ok: true, plan: { ...empty, scopeSnapshot: { targets: [], excludeTargets: [], personalDomains: [] } } }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    await screen.findByText('Plan fingerprint')
    const policy = screen.getByTestId('export-preview-policy').textContent ?? ''
    expect(policy).not.toContain('out-of-scope masked')
    expect(policy).toContain('no web scope set')
    expect(screen.getByTestId('export-scope-unset')).toBeTruthy()
    expect(screen.queryByText('Out of scope (masked)')).toBeNull()
  })
})

// UI/UX audit F12: the preview is a dialog, a failed run keeps it, and a
// finished export can be shown in its folder.
describe('ExportMenu as a dialog', () => {
  afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

  it.each([
    ['source-unavailable', 'changed between the preview and Confirm'],
    ['policy-changed', 'Settings that affect this export']
  ])('explains the known failure %s in words, and still shows the code', async (code, words) => {
    install(async () => ({ ok: true as const, plan: plan(2) }))
    ;(window as unknown as { redlog: { data: Record<string, unknown> } }).redlog.data.executeExportPlan =
      vi.fn(async () => ({ ok: false, error: code }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    fireEvent.click(await screen.findByTestId('export-confirm'))
    const err = await screen.findByTestId('export-run-error')
    expect(screen.getByTestId('export-run-error-meaning').textContent).toContain(words)
    expect(err.textContent).toContain(code)
  })

  it('does not invent a meaning for an unknown failure', async () => {
    install(async () => ({ ok: true as const, plan: plan(2) }))
    ;(window as unknown as { redlog: { data: Record<string, unknown> } }).redlog.data.executeExportPlan =
      vi.fn(async () => ({ ok: false, error: 'disk full' }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    fireEvent.click(await screen.findByTestId('export-confirm'))
    await screen.findByTestId('export-run-error')
    expect(screen.queryByTestId('export-run-error-meaning')).toBeNull()
  })

  it('can recover the previous result after reopening, and reports failed reveal', async () => {
    install(async () => ({ ok: true, plan: plan(2) }))
    const data = window.redlog.data
    vi.mocked(data.recentExport).mockResolvedValue({ ok: true, delivery: { artifactPath: '/tmp/previous.json', format: 'json', completedAt: 1700000000000, availability: 'available' } })
    vi.mocked(data.revealExport).mockResolvedValue(false)
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Export'))
    fireEvent.click(await screen.findByTestId('export-recent'))
    expect(screen.getByTestId('export-completed').textContent).toContain('/tmp/previous.json')
    fireEvent.click(screen.getByTestId('export-reveal'))
    await screen.findByTestId('export-reveal-error')
    expect(screen.getByTestId('export-completed')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByLabelText('Export'))
    expect(await screen.findByTestId('export-recent')).toBeTruthy()
  })

  it('retains the actual successful file until explicitly closed', async () => {
    install(async () => ({ ok: true, plan: plan(2) }))
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    openJson()
    fireEvent.click(await screen.findByTestId('export-confirm'))
    await screen.findByTestId('export-completed')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('export-completed').textContent).toContain('/tmp/x')
    expect(screen.queryByTestId('export-confirm')).toBeNull()
  })
})
