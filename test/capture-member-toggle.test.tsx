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
  // The card sends only the switches it flips (config:patch), each with the
  // value it read.
  let saved: Array<{ path: string[]; value?: unknown }> | null = null
  beforeEach(() => {
    saved = null
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: {
        get: async () => ({ packs: { hostMonitors: false } }),
        patch: async (p: { ops: Array<{ path: string[]; value?: unknown }> }) => { saved = p.ops; return { ok: true, config: {}, revision: 'r' } }
      },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  const fileWatcher = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'file-watcher',
    configPath: 'packMembers.fileWatcher',
    packPath: 'packs.hostMonitors',
    enabled: false,
    state: 'off',
    lastEventAt: null,
    ...over
  })

  it('turns its pack on with it, so the switch does not report the opposite of what it did', async () => {
    // A member is only on when its pack is too. Writing the member alone left
    // the operator flipping a switch and watching the row stay `off`.
    const el = draw([fileWatcher()])
    fireEvent.click(within(el).getByText(/Other capture sources/))
    fireEvent.click(within(el).getByText('turn on'))
    await waitFor(() => expect(saved).not.toBeNull())
    expect(saved).toEqual([
      { path: ['packMembers', 'fileWatcher'], value: true, baseAbsent: true },
      { path: ['packs', 'hostMonitors'], value: true, base: false }
    ])
  })

  it('leaves the pack alone when one member is turned off', async () => {
    // The other members are not this operator's to lose.
    ;(window as unknown as { redlog: { config: { get: () => Promise<unknown> } } }).redlog.config.get =
      async () => ({ packs: { hostMonitors: true } })
    const el = draw([fileWatcher({ enabled: true, state: 'ready', lastEventAt: 1 })])
    fireEvent.click(within(el).getByText(/Other capture sources/))
    fireEvent.click(within(el).getByText('turn off'))
    await waitFor(() => expect(saved).not.toBeNull())
    expect(saved).toEqual([{ path: ['packMembers', 'fileWatcher'], value: false, baseAbsent: true }])
  })
})
