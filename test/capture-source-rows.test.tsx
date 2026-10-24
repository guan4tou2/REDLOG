// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CaptureControlPage from '../src/renderer/src/components/settings/CaptureControlPage'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

// #435: a source row has to answer "is it delivering?" from the row that
// configures it. The answer is a fact about the record — when the source last
// delivered — read from the same snapshot the dashboard's capture card reads,
// so the two screens cannot disagree.

const t = (key: string): string => key
let health: ReturnType<typeof vi.fn>

const initial = {
  engagement: { id: 'capture-source-rows' },
  packs: { hostMonitors: true },
  packMembers: { clipboard: true },
  screenshot: { intervalSec: 30 }
} as unknown as ConfigState

function draw(overrides: Record<string, unknown> = {}) {
  function Harness() {
    const [config, setConfig] = useState({ ...initial, ...overrides } as ConfigState)
    return <I18nProvider><CaptureControlPage config={config} setConfig={setConfig} t={t} /></I18nProvider>
  }
  render(<Harness />)
}

beforeEach(() => {
  health = vi.fn().mockResolvedValue({
    verdict: 'healthy', hasRecorded: true, lastEventAt: null, checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null,
    sources: [
      { id: 'clipboard', installed: true, enabled: true, lastEventAt: 1_700_000_000_000, state: 'ready' },
      { id: 'screenshot', installed: true, enabled: true, lastEventAt: null, state: 'unset' }
    ]
  })
  Object.assign(window, { redlog: {
    plugins: {
      list: vi.fn().mockResolvedValue([{ id: 'pack-host-monitors', source: 'bundled', status: 'active' }]),
      officialAgents: vi.fn().mockResolvedValue([])
    },
    agents: { sources: vi.fn().mockResolvedValue([]) },
    hooks: { detect: vi.fn().mockResolvedValue([]) },
    capture: { health }
  } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('capture source rows', () => {
  it('says when a source last delivered, in the source’s own row', async () => {
    draw()
    const row = await screen.findByTestId('source-last-clipboard')
    expect(row.textContent).toContain('settings.source.lastReceived')
  })

  it('says a source has never delivered rather than showing nothing', async () => {
    draw()
    const row = await screen.findByTestId('source-last-screenshot')
    expect(row.textContent).toContain('settings.source.neverReceived')
  })

  it('leaves out the line for a source the snapshot does not carry', async () => {
    draw()
    await screen.findByTestId('source-last-clipboard')
    expect(screen.queryByTestId('source-last-process-monitor')).toBeNull()
  })

  it('says nothing about a source that is switched off and has never delivered', async () => {
    draw({ screenshot: { intervalSec: 0 } })
    await screen.findByTestId('source-last-clipboard')
    expect(screen.queryByTestId('source-last-screenshot')).toBeNull()
  })

  it('keeps the settings usable when the health read fails', async () => {
    health.mockRejectedValue(new Error('health bridge rejected'))
    draw()
    // The member row is still there — a failing health read must not blank the
    // controls that configure the capture.
    expect(await screen.findByTestId('pack-member-clipboard')).toBeTruthy()
    expect(screen.queryByTestId('source-last-clipboard')).toBeNull()
  })
})
