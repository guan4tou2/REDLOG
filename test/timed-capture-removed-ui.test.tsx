// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import CaptureControlPage from '../src/renderer/src/components/settings/CaptureControlPage'
import AboutPage from '../src/renderer/src/components/settings/AboutPage'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// Ruling 7 (2026-11-12, carried out 2026-11-18): no periodic screenshots, no
// screenshot when a command ends, and the update check runs only when the
// operator presses it. Manual screenshots stay, and so does the one image
// option they use: JPEG quality.

const text = en as Record<string, string>
const t = (key: string, vars?: Record<string, string | number>): string => {
  let s = text[key] ?? key
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, String(v))
  return s
}

beforeEach(() => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    plugins: { list: vi.fn(async () => []), officialAgents: vi.fn(async () => []) },
    agents: { sources: vi.fn(async () => []) },
    hooks: { detect: vi.fn(async () => []) },
    capture: { health: vi.fn(async () => ({ verdict: 'healthy', sources: [] })) },
    app: {
      checkForUpdates: vi.fn(async () => {}),
      updateStatus: vi.fn(async () => ({
        stage: 'idle', method: 'download-page', packaged: true, currentVersion: '1.0.0', targetVersion: null,
        progress: null, result: null, checkedAt: null, releaseUrl: 'https://example.test', unfinished: false
      })),
      onUpdateStatus: vi.fn(() => () => {})
    },
    debug: { status: vi.fn(async () => ({ enabled: false, path: '/x' })), set: vi.fn(), reveal: vi.fn() }
  }
})
afterEach(() => cleanup())

function Capture(): JSX.Element {
  const [config, setConfig] = useState({
    engagement: { id: 'p' }, packs: {}, packMembers: {},
    // An old project file still carrying the removed keys.
    screenshot: { quality: 70, intervalSec: 30, captureOnCommand: true, diffThreshold: 12 }
  } as unknown as ConfigState)
  return <CaptureControlPage config={config} setConfig={setConfig} t={t} />
}

describe('timed screenshots are gone from Settings', () => {
  it('offers no interval, no capture on command end and no differential capture; quality stays', async () => {
    const { container } = render(<Capture />)
    const page = await waitFor(() => container.querySelector('[data-source-id="screenshot"]') as HTMLElement)
    expect(page.textContent).toContain(text['settings.screenshotGroup'])
    expect(page.textContent).not.toMatch(/Every 30s|Every 1m|Every 5m|No scheduled capture/)
    expect(page.textContent).not.toMatch(/command finishes|Differential capture|Every frame|Major changes only/)
    expect(page.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    expect((screen.getByLabelText(text['settings.jpegQuality']) as HTMLInputElement).value).toBe('70')
  })

  it('About has no launch-check switch; the button stays', async () => {
    render(<AboutPage t={t} />)
    expect(await screen.findByTestId('update-check')).toBeTruthy()
    expect(screen.queryByTestId('update-auto-check')).toBeNull()
  })

  it('ships none of the removed strings', () => {
    const gone = /^(settings\.screenshot\.(interval\.|onCommand|diff|options)|update\.autoCheck$)/
    for (const dict of [en, zh] as Array<Record<string, string>>) {
      expect(Object.keys(dict).filter((k) => gone.test(k))).toEqual([])
    }
  })
})
