// @vitest-environment jsdom
//
// The broken-chain banner can be dismissed; the break itself cannot. Dismiss
// used to clear the broken-at id, so the red segment on the track and the
// badge on the row went with the banner, and the Timeline then showed a
// chain that had failed verification as if nothing had.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { setLastVerifyResult } from '../src/renderer/src/lib/verifyResultCache'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
afterEach(() => { cleanup(); setLastVerifyResult(null) })

const brokenSegment = (): Element | null => document.querySelector('.bg-red-500\\/5.border-red-500\\/30')
const brokenBadge = (): Element | null => document.querySelector('[title*="full-chain verify broke here"], [aria-label*="full-chain verify broke here"]')

describe.each(['standard', 'lanes'] as const)('Timeline broken chain (%s mode)', (mode) => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: mode })
    try { localStorage.clear(); localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
  })

  it('keeps the break marked on the track after the banner is dismissed', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)]))
    act(() => { setLastVerifyResult({ ok: false, walked: 1, brokenAtEventId: 'e2', brokenReason: 'hash mismatch' }) })
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
    const banner = await screen.findByTestId('timeline-broken-chain-banner')
    await waitFor(() => expect(brokenSegment(), 'the segment before dismiss').not.toBeNull())
    expect(brokenBadge(), 'the badge before dismiss').not.toBeNull()
    fireEvent.click(banner.querySelector('button') as HTMLElement)
    expect(screen.queryByTestId('timeline-broken-chain-banner')).toBeNull()
    expect(brokenBadge(), 'the badge went with the banner').not.toBeNull()
    expect(brokenSegment(), 'the red segment went with the banner').not.toBeNull()
  })
})
