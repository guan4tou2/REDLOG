// @vitest-environment jsdom
//
// #217: Commands and HTTP(S) are both core capture. Each is verified by an
// event that actually arrived, neither waits on the other, and once the
// operator leaves first-run the Dashboard keeps naming both — so HTTP(S) left
// unset does not fold out of sight the moment a command starts recording.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { commandsVerification, coreCaptureReady, isCommandEvent } from '../src/renderer/src/lib/coreCapture'

const shell = (subtype: string, source?: string): { agentType: string; data: Record<string, unknown> } =>
  ({ agentType: 'shell', data: { subtype, command: 'id', ...(source ? { source } : {}) } })
const http = { agentType: 'scanner', data: { subtype: 'http_request_start' } }

describe('core capture verification', () => {
  it('counts commands, not session bookkeeping or other capture', () => {
    expect(isCommandEvent(shell('command_start'))).toBe(true)
    expect(isCommandEvent(shell('command'))).toBe(true)
    expect(isCommandEvent(shell('command_end'))).toBe(true)
    expect(isCommandEvent(shell('session_start'))).toBe(false)
    expect(isCommandEvent(http)).toBe(false)
  })

  it('says which command path has delivered', () => {
    expect(commandsVerification([])).toBe('none')
    expect(commandsVerification([http, shell('session_start')])).toBe('none')
    expect(commandsVerification([shell('command_end', 'builtin-terminal')])).toBe('builtin')
    expect(commandsVerification([shell('command_end', 'builtin-terminal'), shell('command_end')])).toBe('external')
  })

  it('is ready only with both, and the built-in terminal alone counts for Commands', () => {
    expect(coreCaptureReady({ commands: 'none', http: true })).toBe(false)
    expect(coreCaptureReady({ commands: 'builtin', http: false })).toBe(false)
    expect(coreCaptureReady({ commands: 'builtin', http: true })).toBe(true)
    expect(coreCaptureReady({ commands: 'external', http: true })).toBe(true)
  })
})

function draw(sources: Record<string, unknown>[], managedHttpProxy?: Record<string, unknown>): HTMLElement {
  const capture = { verdict: 'partial', recording: true, sources, lastEventAt: null, checkedAt: 1, ...(managedHttpProxy ? { managedHttpProxy } : {}) }
  const { container } = render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  )
  return container
}

const builtin = { id: 'builtin-terminal', state: 'active', lastEventAt: Date.now() }
const mitm = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'mitmproxy', hookId: 'mitmproxy', installed: true, state: 'idle', lastEventAt: null, ...over })

describe('the Dashboard keeps both core captures in view', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('flags HTTP(S) as not started while commands are recording', () => {
    const el = draw([builtin, mitm()], { state: 'stopped', url: null })
    const cmd = el.querySelector('[data-testid="capture-core-commands"]')
    const web = el.querySelector('[data-testid="capture-core-http"]')
    expect(cmd?.getAttribute('data-state')).toBe('active')
    expect(web?.getAttribute('data-state')).toBe('stopped')
    expect(web?.textContent).toMatch(/not started/i)
  })

  it('shows both as capturing once both are', () => {
    const el = draw([builtin, mitm({ state: 'active', lastEventAt: Date.now() })], { state: 'running', url: null })
    expect(el.querySelector('[data-testid="capture-core-http"]')?.getAttribute('data-state')).toBe('active')
    expect(el.querySelector('[data-testid="capture-core-commands"]')?.getAttribute('data-state')).toBe('active')
  })

  it('flags Commands when only HTTP(S) is recording', () => {
    const el = draw([{ id: 'builtin-terminal', state: 'idle', lastEventAt: null }, mitm({ state: 'active', lastEventAt: Date.now() })], { state: 'running', url: null })
    expect(el.querySelector('[data-testid="capture-core-commands"]')?.getAttribute('data-state')).toBe('todo')
  })
})
