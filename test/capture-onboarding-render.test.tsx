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

  it('renders the sources grouped by what they capture, unnumbered', () => {
    // This was an ordered <ol> of exactly three. The numbering described a
    // sequence that does not exist — an operator on a proxied web assessment
    // starts with traffic and may never install a shell hook — and the three
    // excluded every other source from the model entirely.
    const el = draw(DARK)
    expect(el.querySelectorAll('ol').length, 'a numbered list implies a sequence').toBe(0)
    const text = el.textContent ?? ''
    expect(text).toMatch(/Commands/)
    expect(text).toMatch(/Traffic/)
    expect(text).toMatch(/Screen & files/)
    // The command group still holds the three, in the group's own order.
    const groups = [...el.querySelectorAll('ul')]
    expect(groups.length).toBeGreaterThanOrEqual(3)
    expect(groups[0].textContent).toMatch(/Shell hook/)
  })

  it('surfaces "Install shell hook" as the primary CTA when nothing is wired', () => {
    const el = draw(DARK)
    expect(within(el).getByText('Install shell hook')).toBeTruthy()
  })

  it('points at the wired source once one is set up, not the next unset one', () => {
    // Chosen by state rather than position: the installed hook needs a
    // command, the untouched tailer needs turning on first. The shorter step
    // is the one that gets the operator out of dark.
    const wired = health([
      { id: 'shell-hook', hookId: 'shell-zsh', installed: true, state: 'idle', lastEventAt: null },
      { id: 'agent-tailer', configPath: 'agentTailer.enabled', state: 'idle', lastEventAt: null },
      { id: 'builtin-terminal', state: 'idle', lastEventAt: null }
    ], 'partial')
    const el = draw(wired)
    expect(within(el).getByText('Run a command')).toBeTruthy()
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
