// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
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
    data: {
      resolveExportPlan: async (request: { maskOutOfScope?: boolean }) => {
        lastOpts = request
        if (failResolve) return { ok: false, error: 'selection-failed' }
        return {
          ok: true,
          plan: {
            id: 'plan-1', fingerprint: 'abc', expiresAt: Date.now() + 1000,
            snapshot: { chainedMaxRowId: 1, loggedMaxRowId: 1, takenAt: 1_700_000_000_000 },
            capabilities: { snapshot: true, boundedSubset: false, scopeMasking: true, piiScrubbing: false, attachments: true },
            request: { ...request, format: 'bundle', subset: { kind: 'all' }, sharing: false, scopeOnly: false, scrubPii: false, maskOutOfScope: request.maskOutOfScope !== false },
            counts: {
              examined: 10, included: 8, excludedDoNotExport: 1,
              excludedPersonal: 1, excludedBlacklist: 0, maskedOutOfScope: 2,
              sanitized: 3, attachmentsIncluded: 0, attachmentsMissing: 0,
              attachmentsUnattributed: 0, unsupported: 0
            }
          }
        }
      },
      executeExportPlan: async () => {
        executeCalls++
        return {
          ok: true, planId: 'plan-1', fingerprint: 'abc', artifactPath: '/tmp/b', warnings: [],
          counts: { examined: 10, included: 8, excludedDoNotExport: 1, excludedPersonal: 1, excludedBlacklist: 0, maskedOutOfScope: 2, sanitized: 3, attachmentsIncluded: 0, attachmentsMissing: 0, attachmentsUnattributed: 0, unsupported: 0 }
        }
      },
      exportPreview: async () => ({
        total: 10, included: 8, dropped: 1, personalDropped: 1,
        blacklisted: 0, outOfScope: 2, inScope: 6, sanitized: 3,
        doNotExportCount: 1, hasScope: true, sharing: false
      })
    }
  }
}

const open = (): void => { fireEvent.click(screen.getByLabelText('Export')) }
const clickBundle = (): void => { fireEvent.click(screen.getByText('Evidence bundle (with verifier)')) }
const clickConfirm = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByText('Export')).toBeTruthy())
  const buttons = screen.getAllByText('Export')
  const confirm = buttons.find(b => b.closest('button')?.classList.contains('bg-red-600'))
  expect(confirm).toBeTruthy()
  fireEvent.click(confirm!.closest('button')!)
}

describe('ExportMenu — out-of-scope mask override (A2)', () => {
  beforeEach(() => { installBridge() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('masks by default', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    expect(screen.getByText(/masked \(recommended\)/i)).toBeTruthy()
    clickBundle()
    await clickConfirm()
    await waitFor(() => expect(lastOpts).toMatchObject({ format: 'bundle', maskOutOfScope: true }))
  })

  it('unchecking ships raw out-of-scope content, with a warning label', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
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
    const confirm = screen.getAllByText('Export').find((node) => node.closest('button')?.classList.contains('bg-red-600'))
    expect(confirm).toBeUndefined()
    expect(executeCalls).toBe(0)
  })
})
