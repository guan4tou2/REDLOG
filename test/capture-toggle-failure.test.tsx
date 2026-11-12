// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

// The card's source switch writes that switch (config:patch). A refused write
// (a conflict, another project, an invalid patch) or a rejected one must say
// so and must not refresh the card as if it flipped.

let save: ReturnType<typeof vi.fn>
const onRefresh = vi.fn()
const OK = { ok: true, config: {}, revision: 'r' }

beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  onRefresh.mockClear()
  save = vi.fn(async () => ({ ok: false, reason: 'conflict', conflicts: [], config: {}, revision: 'r' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    config: { get: async () => ({ engagement: { id: 'proj-a' }, packs: { hostMonitors: true } }), patch: (...a: unknown[]) => save(...a) },
    hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
  }
  const capture = {
    verdict: 'partial', recording: false, lastEventAt: null, checkedAt: 1,
    sources: [{ id: 'clipboard', configPath: 'packMembers.clipboard', packPath: 'packs.hostMonitors', enabled: true, state: 'ready', lastEventAt: 1 }]
  }
  render(
    <I18nProvider>
      <ToastContainer />
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={onRefresh} />
    </I18nProvider>
  )
})
afterEach(() => cleanup())

const flip = (): void => {
  fireEvent.click(screen.getByText(/Other capture sources/))
  fireEvent.click(screen.getByText('turn off'))
}

describe('switching a capture source from the Capture Health card', () => {
  it('says so and does not refresh when the write is refused', async () => {
    flip()
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(await screen.findByText('Action failed')).toBeTruthy()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('says so when the write rejects', async () => {
    save = vi.fn(async () => { throw new Error('disk full') })
    flip()
    expect(await screen.findByText('Action failed')).toBeTruthy()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('binds the write to the project the config was read from, and refreshes on success', async () => {
    save = vi.fn(async () => OK)
    flip()
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(save.mock.calls[0][0]).toMatchObject({ expectProjectId: 'proj-a' })
  })
})
