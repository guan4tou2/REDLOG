// @vitest-environment jsdom
//
// G-A3, the last hop: the core decays a verdict once its reading expires, but
// until now `settling`/`stale` were not even DECLARED on the renderer's
// IPStatus, so no surface could show them — a badge could sit on green while
// the reading behind it was 40 seconds dead. Since RedLog never blocks, a
// verdict that fails to reach the operator's eye is the whole defence failing,
// so the decay gets an assertion at the pixel, not just in the state machine.
//
// (Kept separate from `alert-display.test.tsx`, which covers the safe/exposed/
// flash path, so the two files stay independently editable.)

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import IPStatusCard from '../src/renderer/src/components/IPStatusCard'

const unsub = (): void => {}

function installBridge(status: Record<string, unknown>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    ip: { getStatus: async () => status, onStatus: () => unsub },
    pivots: { getActive: async () => [], onChange: () => unsub }
  }
}

const BASE = {
  externalIP: '10.8.0.5',
  internalIP: '10.0.0.2',
  ipSafety: 'safe' as const,
  lastCheck: 1_700_000_000_000,
  error: null as string | null,
  settling: false,
  consecutiveFailures: 0,
  stale: false
}

async function renderCard(over: Partial<typeof BASE> = {}): Promise<void> {
  installBridge({ ...BASE, ...over })
  render(
    <I18nProvider>
      <IPStatusCard />
    </I18nProvider>
  )
  await screen.findByText('10.8.0.5')
}

describe('IPStatusCard — expired and unconfirmed verdicts reach the eye', () => {
  afterEach(cleanup)

  it('a live safe verdict still reads as Safe IP', async () => {
    await renderCard()
    expect(screen.getByText('Safe IP')).toBeTruthy()
    expect(screen.queryByText(/No current reading/i)).toBeNull()
  })

  it('a decayed verdict does NOT read as safe — it says there is no current reading', async () => {
    await renderCard({ ipSafety: 'unknown', stale: true, consecutiveFailures: 3, error: 'offline' })
    expect(screen.queryByText('Safe IP')).toBeNull()
    expect(screen.getByText('No current reading')).toBeTruthy()
  })

  it('the stale hint names the failure count and the kill-switch case', async () => {
    await renderCard({ ipSafety: 'unknown', stale: true, consecutiveFailures: 4, error: 'offline' })
    expect(screen.getByText(/4 consecutive checks/)).toBeTruthy()
    expect(screen.getByText(/kill-switch/)).toBeTruthy()
  })

  // A decayed verdict is also 'unknown', but telling the operator to go
  // configure lists they already configured is the wrong advice for a dead link.
  it('shows the stale hint instead of the "configure your lists" hint', async () => {
    await renderCard({ ipSafety: 'unknown', stale: true, consecutiveFailures: 3 })
    expect(screen.queryByText(/Settings ▸ Network/)).toBeNull()
  })

  it('still shows the "configure your lists" hint for a genuinely unclassified address', async () => {
    await renderCard({ ipSafety: 'unknown' })
    expect(screen.getByText(/Settings ▸ Network/)).toBeTruthy()
  })

  it('keeps the last known address on screen — the decay re-labels, it does not erase', async () => {
    await renderCard({ ipSafety: 'unknown', stale: true, consecutiveFailures: 3 })
    expect(screen.getByText('10.8.0.5')).toBeTruthy()
  })

  it('an unconfirmed address is qualified without being called dead', async () => {
    await renderCard({ settling: true })
    expect(screen.getByText('Safe IP')).toBeTruthy()
    expect(screen.getByText(/being confirmed/)).toBeTruthy()
    expect(screen.queryByText('No current reading')).toBeNull()
  })
})
