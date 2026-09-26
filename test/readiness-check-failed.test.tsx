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

// The panel used to say the RedLog terminal still records when python3 or
// curl was missing. It does not record COMMANDS: the built-in terminal
// sources the same POSIX adapter an external shell does, and that adapter
// builds each event with python3 and posts it with curl. The pane opens and
// its screen output is captured, but no command row reaches the Timeline —
// and the first-run screen ignores session rows, so the operator is told to
// run a command and nothing ever happens.
describe('the readiness panel says what a missing runtime actually costs', () => {
  beforeEach(() => { fail = false; installBridge() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const withChecks = (checks: Array<{ id: string; found: boolean; neededFor: string[] }>): void => {
    const redlog = (window as unknown as { redlog: { runtime: { preflight: unknown } } }).redlog
    redlog.runtime.preflight = vi.fn(async () => ({ ...PREFLIGHT, checks }))
    try { localStorage.clear() } catch { /* ignore */ }
    render(<I18nProvider><RuntimeReadinessHost firstLaunch /></I18nProvider>)
  }

  it('does not claim the built-in terminal still records commands', async () => {
    withChecks([
      { id: 'python3', found: false, neededFor: ['shell-zsh'] },
      { id: 'curl', found: true, neededFor: ['shell-zsh'] },
      { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
    ])
    const note = await screen.findByTestId('readiness-runtime-missing')
    expect(note.textContent).toMatch(/Timeline/)
    expect(note.textContent).not.toMatch(/still records/)
  })

  it('says the machine is ready when the runtime is there', async () => {
    withChecks([
      { id: 'python3', found: true, neededFor: ['shell-zsh'] },
      { id: 'curl', found: true, neededFor: ['shell-zsh'] },
      { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
    ])
    expect(await screen.findByTestId('readiness-core-ok')).not.toBeNull()
    expect(screen.queryByTestId('readiness-runtime-missing')).toBeNull()
  })

  // A missing optional integration must not read as an unfinished install.
  it('keeps a ready verdict when only mitmproxy is absent', async () => {
    withChecks([
      { id: 'python3', found: true, neededFor: ['shell-zsh'] },
      { id: 'curl', found: true, neededFor: ['shell-zsh'] },
      { id: 'mitmdump', found: false, neededFor: ['mitmproxy'] }
    ])
    expect(await screen.findByTestId('readiness-core-ok')).not.toBeNull()
    expect(screen.getByText(/Optional integrations|選用整合/)).not.toBeNull()
  })
})
