// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppCounts } from '../src/renderer/src/lib/useAppCounts'

// The status bar read "scope not set" after a target had been added to the
// scope from the Targets view: it only re-read `isConfigured` on mount and on
// an explicit recount, and a saved config told it nothing. Found by running the
// flow by hand with the scope set and looking at the bar.

function Probe(): JSX.Element {
  const { scopeConfigured, scopeViolations } = useAppCounts()
  return <div data-testid="probe">{scopeConfigured ? 'configured' : 'unset'}:{scopeViolations}</div>
}

function install(state: { configured: boolean; violations: number }): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getCount: vi.fn(async () => 0), onNewBatch: vi.fn(() => () => {}) },
    chain: { length: vi.fn(async () => 0) },
    loot: { getCount: vi.fn(async () => 0) },
    scope: {
      getViolationCount: vi.fn(async () => state.violations),
      isConfigured: vi.fn(async () => state.configured)
    }
  }
}

afterEach(() => cleanup())

describe('useAppCounts after a config save', () => {
  it('re-reads whether a scope is configured', async () => {
    const state = { configured: false, violations: 0 }
    install(state)
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('unset:0'))

    state.configured = true
    window.dispatchEvent(new CustomEvent('redlog:config-saved'))
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('configured:0'))
  })

  it('re-reads the violation count too, since a wider scope can clear violations', async () => {
    const state = { configured: true, violations: 3 }
    install(state)
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('configured:3'))

    state.violations = 0
    window.dispatchEvent(new CustomEvent('redlog:config-saved'))
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('configured:0'))
  })

  it('stops listening once unmounted', async () => {
    const state = { configured: false, violations: 0 }
    install(state)
    const { unmount } = render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('unset:0'))
    unmount()
    const calls = (window as unknown as { redlog: { scope: { isConfigured: ReturnType<typeof vi.fn> } } }).redlog.scope.isConfigured.mock.calls.length
    window.dispatchEvent(new CustomEvent('redlog:config-saved'))
    await new Promise((r) => setTimeout(r, 20))
    expect((window as unknown as { redlog: { scope: { isConfigured: ReturnType<typeof vi.fn> } } }).redlog.scope.isConfigured.mock.calls.length).toBe(calls)
  })
})
