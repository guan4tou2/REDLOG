// @vitest-environment jsdom
//
// The onboarding block on the Capture Health card is what a first-run operator
// sees when the timeline is dark. computeCaptureReadiness (which decides the
// steps and the next action) is unit-tested separately; this proves the card
// actually renders that model — the ordered checklist and the single primary
// CTA — and that the CTA text tracks which core source is next. Without this,
// the render path is only reached by the smoke test's healthy bridge, where the
// block is hidden.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/App'

type Source = {
  id: string
  state: 'active' | 'idle' | 'absent' | 'off'
  installed?: boolean
  hookId?: string
  enabled?: boolean
  configPath?: string
  lastEventAt: number | null
}
function health(sources: Source[], verdict: 'healthy' | 'partial' | 'dark'): any {
  return { verdict, recording: verdict === 'healthy', sources, lastEventAt: null, checkedAt: 1 }
}
function draw(capture: any): HTMLElement {
  const { container } = render(
    <I18nProvider>
      <CaptureHealthCard capture={capture} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  )
  return container
}

// A dark engagement: shell hook not installed, tailer never touched, no terminal.
const DARK = health([
  { id: 'shell-hook', hookId: 'shell-zsh', installed: false, state: 'absent', lastEventAt: null },
  { id: 'agent-tailer', configPath: 'agentTailer.enabled', state: 'idle', lastEventAt: null },
  { id: 'builtin-terminal', state: 'idle', lastEventAt: null }
], 'dark')

describe('CaptureHealthCard onboarding', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('renders the ordered three-step checklist when dark', () => {
    const el = draw(DARK)
    const items = el.querySelectorAll('ol li')
    expect(items.length).toBe(3)
    // In canonical order: shell hook, then agent, then RedLog terminal.
    expect(items[0].textContent).toMatch(/Shell hook/)
    expect(items[1].textContent).toMatch(/agent/i)
    expect(items[2].textContent).toMatch(/RedLog terminal/)
  })

  it('surfaces "Install shell hook" as the primary CTA when nothing is wired', () => {
    const el = draw(DARK)
    expect(within(el).getByText('Install shell hook')).toBeTruthy()
  })

  it('advances the CTA to the agent step once the shell hook is installed', () => {
    const wired = health([
      { id: 'shell-hook', hookId: 'shell-zsh', installed: true, state: 'idle', lastEventAt: null },
      { id: 'agent-tailer', configPath: 'agentTailer.enabled', state: 'idle', lastEventAt: null },
      { id: 'builtin-terminal', state: 'idle', lastEventAt: null }
    ], 'partial')
    const el = draw(wired)
    expect(within(el).getByText('Turn on agent capture')).toBeTruthy()
  })

  it('hides the onboarding block once a core source is recording', () => {
    const live = health([
      { id: 'shell-hook', hookId: 'shell-zsh', installed: true, state: 'active', lastEventAt: 1 },
      { id: 'agent-tailer', configPath: 'agentTailer.enabled', state: 'idle', lastEventAt: null },
      { id: 'builtin-terminal', state: 'idle', lastEventAt: null }
    ], 'healthy')
    const el = draw(live)
    expect(el.querySelector('ol')).toBeNull()
  })
})
