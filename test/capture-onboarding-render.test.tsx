// @vitest-environment jsdom
//
// What a first-run operator sees on the Capture Health card while nothing has
// been recorded yet: the two core captures, named, and one action to take.
//
// There used to be a second block below them — an ordered checklist of the
// same two capabilities, in a third set of words (live / set up / to do),
// shown only until something was recorded. It is gone; this file proves what
// replaced it still answers the question it was there for: what is set up,
// what is not, and what do I do about it.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

type Source = {
  id: string
  state: 'ready' | 'unset' | 'off' | 'error'
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

// A dark engagement: no command recorded from any terminal, the operator's own
// shell hook not installed, tailer never touched, no mitmproxy row at all.
const DARK = health([
  { id: 'terminal', hookId: 'shell-zsh', installed: false, state: 'ready', lastEventAt: null },
  { id: 'agent-tailer', configPath: 'packs.aiAgents', state: 'ready', lastEventAt: null }
], 'dark')

describe('CaptureHealthCard, before anything has been recorded', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('names both core captures, and nothing else, in one list', () => {
    const el = draw(DARK)
    const core = el.querySelector('[data-testid="capture-core"]')
    const text = core?.textContent ?? ''
    expect(text).toMatch(/Commands/)  // zh-TW reads 終端機; the en label is still Commands
    expect(text).toMatch(/HTTP\(S\) requests/)
    // One list, not two: the checklist that used to repeat these is gone, and
    // with it the third vocabulary and the ordered-sequence implication.
    expect(el.querySelectorAll('ol').length, 'a numbered list implies a sequence').toBe(0)
    expect(el.querySelectorAll('[data-testid="capture-core"] ul')).toHaveLength(1)
    // The other sources are one click away under All sources, not advertised.
    expect(el.textContent).not.toMatch(/more capture sources are available/)
  })

  it('says what HTTP(S) buys while it is not set up, because "mitmproxy" does not', () => {
    const el = draw(DARK)
    expect(el.querySelector('[data-testid="capture-core-http"]')?.textContent)
      .toMatch(/requests and responses from any proxied tool/)
  })

  it('offers the zero-install way out of dark, not an installation', () => {
    // The terminal carries a hook id, so the generic rule would have made
    // "Install shell hook" the action. It is not the shortest route: RedLog's
    // own pane records with nothing installed, and opening one is what proves
    // capture works. The hook widens that to the operator's own shell after.
    const el = draw(DARK)
    expect(within(el).getByText('Open a terminal')).toBeTruthy()
    expect(within(el).queryByText('Install shell hook')).toBeNull()
  })

  it('asks for a command once the hook is installed and has never fired', () => {
    const wired = health([
      { id: 'terminal', hookId: 'shell-zsh', installed: true, state: 'ready', lastEventAt: null },
      { id: 'agent-tailer', configPath: 'packs.aiAgents', state: 'ready', lastEventAt: null }
    ], 'partial')
    expect(within(draw(wired)).getByText('Run a command')).toBeTruthy()
  })

  it('drops the action entirely once a command has been recorded', () => {
    const live = health([
      { id: 'terminal', hookId: 'shell-zsh', installed: true, state: 'ready', lastEventAt: 1 },
      { id: 'agent-tailer', configPath: 'packs.aiAgents', state: 'ready', lastEventAt: null }
    ], 'healthy')
    const el = draw(live)
    expect(within(el).queryByText('Open a terminal')).toBeNull()
    expect(within(el).queryByText('Run a command')).toBeNull()
    // …and the core line is still there, which is the whole point of having
    // kept it: it does not disappear the moment onboarding is over.
    expect(el.querySelector('[data-testid="capture-core"]')).toBeTruthy()
  })
})
