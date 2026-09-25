// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { I18nProvider } from '../src/renderer/src/i18n'

// The preview reshaped the resolved plan into an `ExportPreview` whose
// `hasScope` was always false, `screenshotEvents` always 0 and `snapshot` all
// zeros, and whose `inScope` was `included - maskedOutOfScope` — arithmetic,
// not a scope classification. An operator checking what they are about to hand
// to a client was reading numbers RedLog had made up.

const SCOPE = { targets: ['10.0.0.0/24', '*.corp.local'], excludeTargets: [], personalDomains: [] }

const plan = (over: Partial<ResolvedExportPlan> = {}): ResolvedExportPlan => ({
  id: 'plan-1',
  fingerprint: '1234567890abcdef',
  expiresAt: Date.now() + 10_000,
  snapshot: { chainedMaxRowId: 9, loggedMaxRowId: 4, takenAt: 1_700_000_000_000 },
  scopeSnapshot: SCOPE,
  capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: true, attachments: false },
  request: { format: 'json', subset: { kind: 'all' }, sharing: false, maskOutOfScope: true, scopeOnly: false, scrubPii: false },
  counts: {
    examined: 120, included: 100, excludedDoNotExport: 5, excludedPersonal: 7,
    excludedBlacklist: 3, maskedOutOfScope: 5, sanitized: 2,
    attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0
  },
  ...over
})

function install(p: ResolvedExportPlan): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: {
      resolveExportPlan: vi.fn(async () => ({ ok: true as const, plan: p })),
      executeExportPlan: vi.fn(async () => ({ ok: true as const, planId: p.id, fingerprint: 'x', artifactPath: '/tmp/x', counts: p.counts, warnings: [] }))
    },
    config: { get: async () => ({}) }
  }
}

const openJson = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Export/i }))
  fireEvent.click(screen.getByText(/JSON/i))
}

describe('the export preview shows only what the plan measured', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const draw = async (p: ResolvedExportPlan): Promise<void> => {
    install(p)
    render(<I18nProvider><ExportMenu totalCount={120} /></I18nProvider>)
    openJson()
    await waitFor(() => expect(screen.getByTestId('export-preview-scope')).toBeTruthy())
  }

  it('names the real scope rather than claiming there is none', async () => {
    await draw(plan())
    const scope = screen.getByTestId('export-preview-scope').textContent ?? ''
    expect(scope).toContain('10.0.0.0/24')
    expect(scope).toContain('*.corp.local')
  })

  it('says scope is not set when it genuinely is not', async () => {
    await draw(plan({ scopeSnapshot: { targets: [], excludeTargets: [], personalDomains: [] } }))
    expect(screen.getByTestId('export-preview-scope').textContent).toMatch(/not set/i)
  })

  it('shows no invented in-scope or screenshot counts', async () => {
    await draw(plan())
    const panel = screen.getByRole('menu').textContent ?? ''
    // `inScope` was included - maskedOutOfScope = 95, and screenshots was 0.
    expect(panel).not.toMatch(/In scope/i)
    expect(panel).not.toMatch(/Screenshots/i)
    // What the resolver did measure is still there.
    expect(panel).toContain('120')
    expect(panel).toContain('100')
  })

  it('spells out the time range and target of a bounded subset', async () => {
    await draw(plan({
      request: {
        format: 'timeline',
        subset: { kind: 'time-range', since: 1_700_000_000_000, before: 1_700_003_600_000, targetId: '10.0.0.5' },
        sharing: false, maskOutOfScope: true, scopeOnly: false, scrubPii: false
      }
    }))
    const subset = screen.getByTestId('export-preview-subset').textContent ?? ''
    expect(subset).toMatch(/\d/)          // a real timestamp, not just "bounded"
    expect(subset).toContain('10.0.0.5')
  })

  it('names each policy decision, not one preset word', async () => {
    await draw(plan({
      request: { format: 'json', subset: { kind: 'all' }, sharing: true, maskOutOfScope: false, scopeOnly: true, scrubPii: true }
    }))
    const policy = screen.getByTestId('export-preview-policy').textContent ?? ''
    expect(policy).toMatch(/masking off/i)
    expect(policy).toMatch(/in-scope only/i)
    expect(policy).toMatch(/PII scrubbed/i)
  })

  // Three different things that all used to read as "0 attachments".
  it('distinguishes a format that carries no attachments from none being found', async () => {
    await draw(plan())   // json: capabilities.attachments === false
    expect(screen.getByTestId('export-preview-no-attachments').textContent).toMatch(/carries none/i)
  })

  it('reports missing and unattributed attachments for a format that carries them', async () => {
    await draw(plan({
      capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: false, attachments: true },
      counts: { ...plan().counts, attachmentsIncluded: 4, attachmentsMissing: 2, attachmentsUnattributed: 1 }
    }))
    expect(screen.queryByTestId('export-preview-no-attachments')).toBeNull()
    const panel = screen.getByRole('menu').textContent ?? ''
    expect(panel).toMatch(/Attachments missing/i)
    expect(panel).toMatch(/Attachments unattributed/i)
  })
})
