// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'

// A2: the evidence bundle masks out-of-scope captured content by default; the
// operator can override to ship it raw. This proves the ExportMenu toggle
// actually threads that choice down to the exportBundle call — the sensitive
// path (unmasking hands over client data outside the engagement scope) must not
// silently default to raw.

let lastOpts: { maskOutOfScope?: boolean } | undefined
let executeCalls = 0
function installBridge(failResolve = false): void {
  lastOpts = undefined
  executeCalls = 0
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: { recentExport: vi.fn(async () => ({ ok: true, delivery: null })),
      resolveExportPlan: async (request: { maskOutOfScope?: boolean }) => {
        lastOpts = request
        if (failResolve) return { ok: false, error: 'selection-failed' }
        return {
          ok: true,
          plan: {
            id: 'plan-1', fingerprint: 'abc', expiresAt: Date.now() + 1000,
            snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1_700_000_000_000 },
    scopeSnapshot: { targets: ['10.0.0.0/24'], excludeTargets: [], personalDomains: [] },
            capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: false, attachments: true },
            request: { ...request, format: 'bundle', subset: { kind: 'all' }, scopeOnly: false, scrubPii: false, maskOutOfScope: request.maskOutOfScope !== false },
            counts: {
              examined: 10, included: 8, excludedDoNotExport: 1,
              excludedPersonal: 1, maskedOutOfScope: 2,
              sanitized: 3, attachmentsIncluded: 0, attachmentsMissing: 0,
              attachmentsUnattributed: 0, unsupported: 0
            }
          }
        }
      },
      executeExportPlan: async () => {
        executeCalls++
        return {
          ok: true, planId: 'plan-1', fingerprint: 'abc', artifactPath: '/tmp/b', warnings: [], delivery: { artifactPath: '/tmp/x', format: 'json', completedAt: 1700000000000, availability: 'available' },
          counts: { examined: 10, included: 8, excludedDoNotExport: 1, excludedPersonal: 1, maskedOutOfScope: 2, sanitized: 3, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
        }
      },
      exportPreview: async () => ({
        total: 10, included: 8, dropped: 1, personalDropped: 1,
        blacklisted: 0, outOfScope: 2, inScope: 6, sanitized: 3,
        doNotExportCount: 1, hasScope: true
      })
    }
  }
}

const open = (): void => { fireEvent.click(screen.getByLabelText('Export')) }
const clickBundle = (): void => { fireEvent.change(screen.getByLabelText('Export format'), { target: { value: 'bundle' } }) }
const clickConfirm = async (): Promise<void> => {
  const dialog = await screen.findByRole('dialog')
  const confirm = await within(dialog).findByTestId('export-confirm')
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(confirm)
}

describe('ExportMenu — out-of-scope mask override (A2)', () => {
  beforeEach(() => { installBridge() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('masks by default', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    expect(screen.getByText(/mask out-of-scope content using web scope/i)).toBeTruthy()
    clickBundle()
    await clickConfirm()
    await waitFor(() => expect(lastOpts).toMatchObject({ format: 'bundle', maskOutOfScope: true }))
  })

  it('unchecking ships raw out-of-scope content, with a warning label', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    // Two checkboxes now that the 自用/交付 preset is gone: this one and the
    // PII scrub it used to stand in for. Pick the mask by its own label.
    fireEvent.click(screen.getByLabelText(/mask out-of-scope content using web scope/i))
    expect(screen.getByText(/including out-of-scope content raw/i)).toBeTruthy()
    clickBundle()
    await clickConfirm()
    await waitFor(() => expect(lastOpts).toMatchObject({ format: 'bundle', maskOutOfScope: false }))
  })

  it('shows preview failure and cannot execute an unreviewed export', async () => {
    installBridge(true)
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    clickBundle()
    expect((await screen.findByRole('alert')).textContent).toContain('selection-failed')
    expect(screen.queryByTestId('export-confirm')).toBeNull()
    expect(executeCalls).toBe(0)
  })
})
