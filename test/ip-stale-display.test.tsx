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
  ipSafety: 'safe' as 'safe' | 'presumed_safe' | 'off_profile' | 'exposed' | 'unknown',
  lastCheck: 1_700_000_000_000,
  error: null as string | null,
  settling: false,
  consecutiveFailures: 0,
  stale: false,
  listConflict: false,
  lanSafety: 'unknown' as 'safe' | 'off_profile' | 'unknown'
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

// G-A2 at the pixel. The claim of this ticket is that an inference must not
// look like a fact and an observed deviation must not look like missing
// information — both are claims about what the operator SEES, so neither is
// proved by a unit test on the verdict alone.
describe('IPStatusCard — the five verdicts are distinguishable', () => {
  afterEach(cleanup)

  it('a verified exit reads as Safe IP with no caveat', async () => {
    await renderCard({ ipSafety: 'safe' })
    expect(screen.getByText('Safe IP')).toBeTruthy()
    expect(screen.queryByText(/inference/i)).toBeNull()
  })

  it('an inferred exit does NOT read as Safe IP', async () => {
    await renderCard({ ipSafety: 'presumed_safe' })
    expect(screen.queryByText('Safe IP')).toBeNull()
    expect(screen.getByText('Presumed safe')).toBeTruthy()
    expect(screen.getByText(/nothing to confirm it against/)).toBeTruthy()
  })

  it('a whitelist miss reads as a deviation, not as missing information', async () => {
    await renderCard({ ipSafety: 'off_profile' })
    expect(screen.getByText('Off-profile IP')).toBeTruthy()
    // The old behaviour: same amber "go configure your lists" advice as a
    // completely unconfigured RedLog. The lists ARE configured — that is the
    // whole point of the verdict.
    expect(screen.queryByText(/Settings ▸ Network to enable classification/)).toBeNull()
    expect(screen.getByText(/not where you declared/)).toBeTruthy()
  })

  it('an unconfigured RedLog still gets the configure-your-lists advice', async () => {
    await renderCard({ ipSafety: 'unknown' })
    expect(screen.getByText(/Settings ▸ Network/)).toBeTruthy()
  })

  it('surfaces a contradictory config without changing the verdict', async () => {
    await renderCard({ ipSafety: 'exposed', listConflict: true })
    expect(screen.getByText('Exposed IP')).toBeTruthy()
    expect(screen.getByText(/BOTH your Safe IP and Exposed IP lists/)).toBeTruthy()
  })

  it('says nothing about lists when they do not contradict', async () => {
    await renderCard({ ipSafety: 'exposed', listConflict: false })
    expect(screen.queryByText(/BOTH your Safe IP/)).toBeNull()
  })
})

// G-A4 at the pixel: the internal address used to be inert text.
describe('IPStatusCard — the internal address is judged too', () => {
  afterEach(cleanup)

  it('says nothing when no LAN profile is declared', async () => {
    await renderCard({ lanSafety: 'unknown' })
    expect(screen.getByText('10.0.0.2')).toBeTruthy()
    expect(screen.queryByText(/wrong network/)).toBeNull()
  })

  it('flags an internal address off the expected segment', async () => {
    await renderCard({ lanSafety: 'off_profile' })
    expect(screen.getByText(/not on any of the LAN segments/)).toBeTruthy()
    expect(screen.getByText(/guest SSID/)).toBeTruthy()
  })

  // The point of the whole ticket: the external verdict cannot catch this.
  it('an off-profile LAN is flagged even while the egress reads safe', async () => {
    await renderCard({ ipSafety: 'safe', lanSafety: 'off_profile' })
    expect(screen.getByText('Safe IP')).toBeTruthy()
    expect(screen.getByText(/wrong network/)).toBeTruthy()
  })

  it('says nothing when the internal address is where it should be', async () => {
    await renderCard({ lanSafety: 'safe' })
    expect(screen.queryByText(/wrong network/)).toBeNull()
  })
})
