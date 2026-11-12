// @vitest-environment jsdom
//
// At 800px and 125% text zoom (~640 CSS px) the status bar folded the IP-safety
// and scope chips to unlabeled dots: the OPSEC state became unreadable exactly
// when space was tight. Narrow, the bar now sheds lower-value items instead.
// jsdom has no layout, so this pins which items render at which width; whether
// it all fits on one row is a real-window check.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

const noop = (): void => {}
function installBridge(): void {
  const named: Record<string, Record<string, unknown>> = {
    capture: { health: async () => ({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    events: { getCount: async () => 5, onNewBatch: () => noop },
    ip: { getStatus: async () => ({ safety: 'exposed', externalIP: '203.0.113.9' }), onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => false, getLastRecompute: async () => null },
    project: { active: async () => ({ createdAt: Date.now() - 60_000 }) }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

const width = (px: number): void => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: px }) }
const visibleWord = (testid: string): string => {
  const el = screen.getByTestId(testid)
  expect(el.className).not.toContain('sr-only')
  expect(el.getAttribute('aria-hidden')).toBeNull()
  return el.textContent ?? ''
}

beforeEach(() => {
  window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en')
  _resetCaptureHealth(); _resetIssues(); installBridge()
})
afterEach(() => { cleanup(); width(1024) })

it('keeps the IP and scope words at a narrow width, and sheds the uptime and event count', async () => {
  width(600)
  render(<I18nProvider><StatusBar /></I18nProvider>)
  expect(screen.getByTestId('status-bar').getAttribute('data-narrow')).toBe('true')
  await waitFor(() => expect(visibleWord('status-bar-scope-state')).toBe('SCOPE —'))
  expect(visibleWord('status-bar-ip-state')).toBeTruthy()
  expect(screen.queryByTestId('statusbar-uptime')).toBeNull()
  expect(screen.queryByTestId('statusbar-event-count')).toBeNull()
})

it('shows everything at a wide width', async () => {
  width(1400)
  render(<I18nProvider><StatusBar /></I18nProvider>)
  expect(screen.getByTestId('status-bar').getAttribute('data-narrow')).toBe('false')
  await waitFor(() => expect(visibleWord('status-bar-scope-state')).toBe('SCOPE —'))
  expect(screen.getByTestId('statusbar-uptime')).toBeTruthy()
  expect(screen.getByTestId('statusbar-event-count')).toBeTruthy()
})
