// @vitest-environment jsdom
//
// The card's per-source switch writes config directly. A pack member has two
// halves — its own opt-out and the pack it belongs to — and getting the write
// wrong means a control that reports the opposite of what it just did.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

function draw(sources: Record<string, unknown>[]): HTMLElement {
  const capture = { verdict: 'partial', recording: false, sources, lastEventAt: null, checkedAt: 1 }
  const { container } = render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  )
  return container
}

describe('turning a pack member on from the Capture Health card', () => {
  let saved: Record<string, unknown> | null = null
  beforeEach(() => {
    saved = null
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: {
        get: async () => ({ packs: { hostMonitors: false } }),
        save: async (c: Record<string, unknown>) => { saved = c; return true }
      },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  const clipboard = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'clipboard',
    configPath: 'packMembers.clipboard',
    packPath: 'packs.hostMonitors',
    enabled: false,
    state: 'off',
    lastEventAt: null,
    ...over
  })

  it('turns its pack on with it, so the switch does not report the opposite of what it did', async () => {
    // A member is only on when its pack is too. Writing the member alone left
    // the operator flipping a switch and watching the row stay `off`.
    const el = draw([clipboard()])
    fireEvent.click(within(el).getByText(/all sources/))
    fireEvent.click(within(el).getByText('turn on'))
    await waitFor(() => expect(saved).not.toBeNull())
    expect(saved).toMatchObject({
      packs: { hostMonitors: true },
      packMembers: { clipboard: true }
    })
  })

  it('leaves the pack alone when one member is turned off', async () => {
    // The other three members are not this operator's to lose.
    ;(window as unknown as { redlog: { config: { get: () => Promise<unknown> } } }).redlog.config.get =
      async () => ({ packs: { hostMonitors: true } })
    const el = draw([clipboard({ enabled: true, state: 'idle', lastEventAt: 1 })])
    fireEvent.click(within(el).getByText(/all sources/))
    fireEvent.click(within(el).getByText('turn off'))
    await waitFor(() => expect(saved).not.toBeNull())
    expect(saved).toMatchObject({
      packs: { hostMonitors: true },
      packMembers: { clipboard: false }
    })
  })
})
