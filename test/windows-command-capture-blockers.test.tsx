// @vitest-environment jsdom
//
// F6: on Windows the first-run screen could not name a single reason commands
// were not arriving.
//
// `missingDependencies` was hardcoded to python3 and curl — the POSIX
// adapter's dependencies — and win32 preflight does not check either, so the
// list was empty by construction and the screen fell through to the generic
// "nothing is arriving" text ten seconds later. Meanwhile the actual Windows
// cause is silent and specific: Windows PowerShell 5.1 ships with
// ExecutionPolicy = Restricted on client SKUs, which blocks scripts — and
// $PROFILE is a script. RedLog writes its hook line into the profile, the
// profile never loads, and the operator's own terminal records nothing. The
// built-in terminal keeps working, because it is spawned with
// -ExecutionPolicy Bypass, which makes the failure read as "my terminal is
// broken" rather than "a policy is blocking the profile".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { blocksProfileScripts, SET_EXECUTION_POLICY } from '../src/core/powershell-policy'
import { commandCaptureBlockers, SET_EXECUTION_POLICY as RENDERER_FIX } from '../src/renderer/src/lib/terminalActivation'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: () => <div data-testid="terminal" /> }))

import { FirstRunView } from '../src/renderer/src/components/FirstRunView'

const winPreflight = (over: Partial<RuntimePreflight> = {}): RuntimePreflight => ({
  platform: 'win32',
  shell: { name: 'powershell', hookId: 'shell-powershell' },
  checks: [
    { id: 'powershell', found: true, neededFor: ['shell-powershell'] },
    { id: 'pwsh', found: false, neededFor: ['shell-powershell'] },
    { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
  ],
  legacyHooks: [],
  powershell: { shell: 'powershell', policy: 'Restricted', blocksProfile: true },
  ...over
})

function install(pre: RuntimePreflight): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { query: vi.fn(async () => []), onNewBatch: () => () => {} },
    runtime: { preflight: vi.fn(async () => pre), install: vi.fn() },
    hooks: { install: vi.fn(async () => ({ success: true, message: 'ok' })) },
    app: { openExternal: vi.fn(async () => {}) },
    httpCapture: {
      status: vi.fn(async () => ({ state: 'stopped', url: null })),
      start: vi.fn(), stop: vi.fn(), verifyInBrowser: vi.fn(),
      onVerify: () => () => {}
    },
    browser: { launch: vi.fn() },
    config: { get: async () => ({}), save: vi.fn(async () => true) },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    wsl: { listDistros: vi.fn(async () => []), installHook: vi.fn() }
  }
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); localStorage.clear() })

describe('execution policy', () => {
  it('names the policies under which a dot-sourced profile will not run', () => {
    // Restricted is the Windows client default; AllSigned rejects the unsigned
    // hook RedLog writes; Undefined in every scope IS Restricted on a client.
    expect(blocksProfileScripts('Restricted')).toBe(true)
    expect(blocksProfileScripts('AllSigned')).toBe(true)
    expect(blocksProfileScripts('Undefined')).toBe(true)
    expect(blocksProfileScripts('RemoteSigned')).toBe(false)
    expect(blocksProfileScripts('Unrestricted')).toBe(false)
    expect(blocksProfileScripts('Bypass')).toBe(false)
    // An unknown answer is not a blocker: never invent a cause.
    expect(blocksProfileScripts('')).toBe(false)
    expect(blocksProfileScripts('something-new')).toBe(false)
  })

  it('scopes the fix to the current user', () => {
    expect(SET_EXECUTION_POLICY).toContain('-Scope CurrentUser')
    expect(SET_EXECUTION_POLICY).not.toMatch(/Unrestricted|Bypass/)
  })

  it('offers the same fix in the renderer as in core', () => {
    // The renderer restates the command rather than importing a module that
    // spawns processes. Two copies of a command the operator will run is
    // exactly the kind of drift worth pinning.
    expect(RENDERER_FIX).toBe(SET_EXECUTION_POLICY)
  })
})

describe('command capture blockers', () => {
  it('reports the execution policy on Windows and the missing commands on POSIX', () => {
    expect(commandCaptureBlockers(winPreflight())).toEqual([
      { kind: 'execution-policy', policy: 'Restricted', remediation: SET_EXECUTION_POLICY }
    ])
    // A policy that allows the profile is not a blocker.
    expect(commandCaptureBlockers(winPreflight({
      powershell: { shell: 'pwsh', policy: 'RemoteSigned', blocksProfile: false }
    }))).toEqual([])
    // An unmeasured policy is not a blocker either — "not asked" is not "broken".
    expect(commandCaptureBlockers(winPreflight({ powershell: null }))).toEqual([])
    // POSIX keeps naming the commands the adapter needs.
    const posix: RuntimePreflight = {
      platform: 'darwin',
      shell: { name: 'zsh', hookId: 'shell-zsh' },
      checks: [
        { id: 'python3', found: false, neededFor: ['shell-zsh'], remediation: 'brew install python' },
        { id: 'curl', found: true, neededFor: ['shell-zsh'] }
      ],
      legacyHooks: []
    }
    const blockers = commandCaptureBlockers(posix)
    expect(blockers).toHaveLength(1)
    expect(blockers[0].kind).toBe('missing-command')
  })
})

describe('first run on Windows', () => {
  it('names the execution policy instead of waiting to say nothing is arriving', async () => {
    install(winPreflight())
    render(<I18nProvider><FirstRunView onNavigate={vi.fn()} renderCaptureCard={() => <div />} /></I18nProvider>)

    const blocked = await screen.findByTestId('first-run-blocked')
    expect(blocked.textContent).toContain('Restricted')
    expect(blocked.textContent).toContain(SET_EXECUTION_POLICY)
    // The built-in terminal still records, and saying so is the difference
    // between "my machine is broken" and "my own terminal is not hooked yet".
    expect(blocked.textContent).toContain('內建終端')
    // And it does not tell the operator to just run a command and hope.
    expect(screen.queryByTestId('first-run-commands-quick')).toBeNull()
  })

  it('keeps the quick test when nothing blocks capture', async () => {
    install(winPreflight({ powershell: { shell: 'pwsh', policy: 'RemoteSigned', blocksProfile: false } }))
    render(<I18nProvider><FirstRunView onNavigate={vi.fn()} renderCaptureCard={() => <div />} /></I18nProvider>)
    expect(await screen.findByTestId('first-run-commands-quick')).toBeTruthy()
    expect(screen.queryByTestId('first-run-blocked')).toBeNull()
  })
})
