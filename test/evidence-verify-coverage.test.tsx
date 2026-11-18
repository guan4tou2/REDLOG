// @vitest-environment jsdom
//
// Cases of the verification block the review found untested.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAccessibleName } from 'dom-accessibility-api'

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/components/Toast', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/Toast')>()), toast: toastSpy
}))

import { EvidenceHeader } from '../src/renderer/src/components/EvidenceHeader'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetIssues } from '../src/renderer/src/lib/issues'
import { formatWhen } from '../src/renderer/src/lib/time'
import { noteOpenProject, setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'

const NOW = Date.now()
const accepted: ChainAnchorInfo = {
  id: 'a1', headEventId: 'e3', headHash: 'f'.repeat(64), eventCount: 3, status: 'complete', createdAt: NOW - 60_000, completedAt: null,
  calendarReceipts: [{ calendar: 'https://a.example.org', ok: true, submittedAt: NOW }]
}
const intact = { ok: true, walked: 3, anchor: accepted, anchorMatchesWalkedHead: true, authentication: 'verified', signedCount: 3, unsignedCount: 0, noPubKeyCount: 0 }

function install(over: { length?: () => Promise<number>; verify?: () => Promise<unknown> } = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { count: vi.fn(async () => 0), onNewBatch: () => () => {} },
    bookmarks: { list: vi.fn(async () => []) },
    project: { active: vi.fn(async () => ({ id: 'p1', name: 'demo' })) },
    chain: {
      anchors: vi.fn(async () => [accepted]), length: vi.fn(over.length ?? (async () => 3)),
      verify: vi.fn(over.verify ?? (async () => intact)), anchorNow: vi.fn(), upgrade: vi.fn(async () => ({ upgraded: 0, scanned: 0 }))
    }
  }
}
const mount = (): void => { render(<I18nProvider><EvidenceHeader page="screenshots" onNavigate={vi.fn()} /></I18nProvider>) }
const line = (): HTMLElement => screen.getByTestId('evidence-verify-line')

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); noteOpenProject('p1') })
afterEach(() => { cleanup(); _resetIssues(); setLastVerifyResult(null); noteOpenProject(null); toastSpy.mockClear(); vi.restoreAllMocks() })

describe('the verification block, the cases the review named', () => {
  it('heads incomplete signatures in the caution colour, never the intact one', async () => {
    setLastVerifyResult({ ...intact, authentication: 'failed', unsignedCount: 1, authenticationReasons: ['1 row has no signature'] }, { projectId: 'p1', verifiedAt: NOW })
    install()
    mount()
    const head = within(line()).getByText('Signatures incomplete')
    expect(head.className).toContain('amber')
    expect(head.className).not.toContain('emerald')
  })

  it('treats authentication "none" as a qualified tick: intact, with "not signature-checked" on the line', async () => {
    setLastVerifyResult({ ...intact, authentication: 'none', signedCount: 0, unsignedCount: 3 }, { projectId: 'p1', verifiedAt: NOW })
    install()
    mount()
    await waitFor(() => expect(line().textContent).toContain('▲ 3 not signature-checked'))
    expect(line().textContent).toContain('Chain intact')
  })

  it('says additions since are unknown when the length cannot be read after a walk', async () => {
    setLastVerifyResult(intact, { projectId: 'p1', verifiedAt: NOW })
    install({ length: async () => { throw new Error('db locked') } })
    mount()
    await waitFor(() => expect(line().textContent).toContain('▲ Additions since unknown'))
  })

  it('says the chain changed when it is shorter than what was walked', async () => {
    setLastVerifyResult({ ...intact, walked: 5 }, { projectId: 'p1', verifiedAt: NOW - 1000 })
    install({ length: async () => 3 })
    mount()
    await waitFor(() => expect(line().textContent).toContain('▲ Changed since; verify again'))
  })

  it('shows the time the walk finished, not the time now', () => {
    const at = NOW - 3 * 86_400_000 - 12_345
    setLastVerifyResult(intact, { projectId: 'p1', verifiedAt: at })
    install()
    mount()
    expect(line().textContent).toContain(`Verified ${formatWhen(at, { seconds: true })}`)
    expect(formatWhen(at, { seconds: true })).not.toBe(formatWhen(Date.now(), { seconds: true }))
  })

  it('says so in a toast when the walk cannot run, and leaves no result', async () => {
    install({ verify: async () => { throw new Error('ipc down') } })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Verification could not run', expect.objectContaining({ type: 'error', detail: 'ipc down' })))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Verify' }) as HTMLButtonElement).disabled).toBe(false))
    expect(line().textContent).toContain('Not verified yet')
  })

  it('gives every control in the block an accessible name', async () => {
    install()
    mount()
    fireEvent.click(within(line()).getByRole('button', { name: 'Details' }))
    const details = screen.getByTestId('evidence-verify-details')
    await within(details).findByRole('button', { name: 'Upgrade pending' })
    const names = within(screen.getByTestId('evidence-verify')).getAllByRole('button').map((b) => computeAccessibleName(b))
    expect(names).toEqual(['Verify', 'Details', 'Anchor now', 'Upgrade pending'])
  })
})
