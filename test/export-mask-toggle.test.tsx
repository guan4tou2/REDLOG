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
function installBridge(): void {
  lastOpts = undefined
  ;(window as unknown as { redlog: unknown }).redlog = {
    data: {
      exportBundle: async (opts?: { maskOutOfScope?: boolean }) => { lastOpts = opts; return { ok: true, zipPath: '/tmp/b.zip' } }
    }
  }
}

const open = (): void => { fireEvent.click(screen.getByTitle('Export')) }
const clickBundle = (): void => { fireEvent.click(screen.getByText('Evidence bundle (with verifier)')) }

describe('ExportMenu — out-of-scope mask override (A2)', () => {
  beforeEach(() => { installBridge() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('masks by default', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    // Default: the checkbox is checked and the "recommended" label shows.
    expect(screen.getByText(/masked \(recommended\)/i)).toBeTruthy()
    clickBundle()
    await waitFor(() => expect(lastOpts).toEqual({ maskOutOfScope: true }))
  })

  it('unchecking ships raw out-of-scope content, with a warning label', async () => {
    render(<I18nProvider><ExportMenu /></I18nProvider>)
    open()
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox) // uncheck → include raw
    expect(screen.getByText(/client data outside your engagement scope/i)).toBeTruthy()
    clickBundle()
    await waitFor(() => expect(lastOpts).toEqual({ maskOutOfScope: false }))
  })
})
