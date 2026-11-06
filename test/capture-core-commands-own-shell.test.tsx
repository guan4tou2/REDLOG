// @vitest-environment jsdom
//
// The Commands line of the core capture block says the same three-way thing
// about the operator's own shell as the terminal row: installed is not recording.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

function draw(terminal: Record<string, unknown>): HTMLElement {
  const capture = {
    verdict: 'partial', recording: false, lastEventAt: null, checkedAt: 1,
    sources: [{ id: 'terminal', hookId: 'terminal', state: 'ready', lastEventAt: null, ...terminal }]
  }
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  ).container
}
const line = (el: HTMLElement): string =>
  el.querySelector('[data-testid="capture-core-commands-own-shell"]')?.textContent ?? ''

describe('Commands line in the core capture block', () => {
  beforeEach(() => {
    window.localStorage.setItem('redlog-locale', 'en')
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => { cleanup(); window.localStorage.clear() })

  it('says the own shell is missing when the hook is not installed', () => {
    expect(line(draw({ installed: false }))).toContain('Your own terminal is not in the record')
  })
  it('says pending, not included, when installed but nothing has arrived', () => {
    const text = line(draw({ installed: true, ownShellLastEventAt: null }))
    expect(text).toContain('Shell hook installed')
    expect(text).not.toContain('last command')
  })
  it('says commands only until an output is recorded, then included', () => {
    const base = { installed: true, ownShellName: 'zsh', ownShellLastEventAt: Date.now() }
    expect(line(draw(base))).toContain('no command output recorded yet')
    cleanup()
    expect(line(draw({ ...base, ownShellOutputAt: Date.now() }))).toContain('last output')
  })
})
