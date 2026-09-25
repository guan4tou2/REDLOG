// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeReadinessHost } from '../src/renderer/src/components/RuntimeReadiness'
import { I18nProvider } from '../src/renderer/src/i18n'

// "The check failed" is not "still checking", and it is certainly not
// "everything is fine". usePreflight swallowed its rejection, leaving `data`
// null, which this panel renders as a loading line - forever, with no way to
// ask again. The one screen whose job is to say whether RedLog can record sat
// on a spinner instead.

const PREFLIGHT = {
  platform: 'darwin',
  shell: { name: 'zsh', hookId: 'shell-zsh' },
  checks: [
    { id: 'python3', found: true, neededFor: ['shell-zsh'] },
    { id: 'curl', found: true, neededFor: ['shell-zsh'] },
    { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
  ],
  legacyHooks: []
}

let fail = false
function installBridge(): void {
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    runtime: { preflight: vi.fn(async () => { if (fail) throw new Error('no bridge'); return PREFLIGHT }) },
    hooks: { migrateLegacy: async () => ({ ok: true }) }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
}

describe('the readiness panel says when the check itself failed', () => {
  beforeEach(() => { fail = false; installBridge() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const mount = (): void => {
    try { localStorage.clear() } catch { /* ignore */ }
    render(<I18nProvider><RuntimeReadinessHost firstLaunch /></I18nProvider>)
  }

  it('reports the failure instead of loading forever, and the re-check recovers', async () => {
    fail = true
    mount()
    expect(await screen.findByTestId('readiness-check-failed')).not.toBeNull()

    fail = false
    // The panel's own retry, not the footer's — they share a label.
    const failed = screen.getByTestId('readiness-check-failed')
    fireEvent.click(failed.querySelector('button')!)
    await waitFor(() => expect(screen.queryByTestId('readiness-check-failed')).toBeNull())
    expect(await screen.findByText('python3')).not.toBeNull()
  })

  it('shows the checks normally when it succeeds', async () => {
    mount()
    expect(await screen.findByText('python3')).not.toBeNull()
    expect(screen.queryByTestId('readiness-check-failed')).toBeNull()
  })
})
