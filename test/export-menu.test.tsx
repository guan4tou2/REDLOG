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

  // Sharing mode scrubs operator PII, which the evidence bundle cannot do, so
  // the plan resolver refuses the pair (unsupported-policy). The menu must not
  // offer it as if it would work.
  it('does not offer a format that cannot honour sharing mode', () => {
    install(vi.fn())
    render(<I18nProvider><ExportMenu totalCount={1} /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Export'))
    const bundle = (): HTMLButtonElement | null => screen.getByText('Evidence bundle (with verifier)').closest('button')
    expect(bundle()?.disabled).toBe(false)
    fireEvent.click(screen.getByText('For sharing'))
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
    // The policy line now names each decision rather than one preset word:
    // an operator checking a delivery has to see whether masking was on.
    const policy = screen.getByTestId('export-preview-policy').textContent ?? ''
    expect(policy).toContain('For sharing')
    expect(policy).toContain('out-of-scope masked')
    expect(policy).toContain('PII scrubbed')
    // And the boundary it was resolved against, which the menu used to
    // hardcode as `hasScope: false`.
    expect(screen.getByTestId('export-preview-scope').textContent).toContain('10.0.0.0/24')
    expect(screen.getByText('1234567890ab')).toBeTruthy()
    expect(screen.getByText('Data snapshot')).toBeTruthy()
  })
})
