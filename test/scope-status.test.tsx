// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ScopeStatus } from '../src/renderer/src/components/ScopeStatus'

// The Scope & Evidence page against a stubbed bridge. Its rows are a window,
// the newest records the read model returns (queryScopeViolationRows), while
// the status bar counts every standing violation in the chain. The page must
// not claim anything only the whole chain can know from the window alone: a
// total, or "all commands within scope" (TESTING.md G-S3).

interface Row {
  id: string
  target: string
  command: string
  timestamp: number
  distance: string
  judged: 'live' | 'retroactive'
  cleared: boolean
}
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, target: `${id}.example`, command: `curl ${id}.example`, timestamp: 1_700_000_000_000,
  distance: 'excluded', judged: 'live', cleared: false, ...over
})

function installBridge(page: { rows: Row[]; truncated: boolean }, standing: number): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    scope: {
      getViolations: async () => page,
      getViolationCount: async () => standing,
      isConfigured: async () => true,
      getLastRecompute: async () => null
    },
    chain: { length: async () => 0 },
    events: { onNewBatch: () => () => {} }
  }
}

const open = async (): Promise<void> => {
  render(<I18nProvider><ScopeStatus /></I18nProvider>)
  await screen.findByText('Scope Monitor')
}

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => cleanup())

describe('Scope & Evidence page', () => {
  it('expands the recorded basis and full source command without silently changing scope', async () => {
    installBridge({ rows: [row('v1')], truncated: false }, 1)
    const full = 'curl https://v1.example/' + 'argument'.repeat(100)
    window.redlog.events.getById = vi.fn(async ids => ids[0] === 'v1'
      ? [{ id: 'v1', data: { matched_by: '*.example', _causes: ['source'] } }]
      : [{ id: 'source', agentType: 'shell', data: { command: full } }]) as never
    const onOpenSettings = vi.fn()
    render(<I18nProvider><ScopeStatus onOpenSettings={onOpenSettings} /></I18nProvider>)
    fireEvent.click(await screen.findByTestId('scope-judged-live'))
    expect(await screen.findByText(full)).toBeTruthy()
    expect(screen.getByText(/Matched exclusion rule.*\*\.example/)).toBeTruthy()
    expect(onOpenSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit related scope rules' }))
    expect(onOpenSettings).toHaveBeenCalledWith('v1.example')
  })

  it.each(['getViolations', 'getLastRecompute'] as const)('shows a failed %s read and recovers on retry without claiming an empty result', async method => {
    installBridge({ rows: [], truncated: false }, 0)
    vi.spyOn(window.redlog.scope, method).mockRejectedValueOnce(new Error('read refused'))
    render(<I18nProvider><ScopeStatus /></I18nProvider>)
    expect((await screen.findByRole('alert')).textContent).toContain('read refused')
    expect(screen.queryByText('All commands within scope')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }))
    await screen.findByText('Scope Monitor')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('All commands within scope')).toBeTruthy()
  })

  it('counts the violations the status bar counts, not the ones in the window', async () => {
    installBridge({ rows: [row('a'), row('b'), row('c')], truncated: true }, 7)
    await open()
    const label = screen.getByText('violations still standing')
    expect(label.previousElementSibling?.textContent).toBe('7')
  })

  it('says the list is cut whenever it is, even with no standing row in the window', async () => {
    // The newest records were all withdrawn; older ones still stand.
    installBridge({ rows: [row('a', { cleared: true }), row('b', { cleared: true })], truncated: true }, 2)
    await open()
    expect(screen.queryByTestId('scope-truncated')).not.toBeNull()
  })

  it('never says all commands are within scope while a violation stands', async () => {
    installBridge({ rows: [], truncated: false }, 1)
    await open()
    expect(screen.queryByText('All commands within scope')).toBeNull()
  })

  it('says it when nothing stands and nothing was recorded', async () => {
    installBridge({ rows: [], truncated: false }, 0)
    await open()
    expect(screen.queryByText('All commands within scope')).not.toBeNull()
  })
  it('opens scope settings from an unconfigured monitor', async () => {
    installBridge({ rows: [], truncated: false }, 0)
    window.redlog.scope.isConfigured = vi.fn(async () => false)
    const onOpenSettings = vi.fn()
    render(<I18nProvider><ScopeStatus onOpenSettings={onOpenSettings} /></I18nProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(screen.queryByText('All commands within scope')).toBeNull()
  })

})
