// @vitest-environment jsdom
//
// The status bar, the dashboard card and the HUD show an IP status as safe
// only when it carries an address and no failed read. Each test hands every
// surface the same status; a "safe" with no address in it is the shape a
// stubbed `ip:getStatus` produced in a reference screenshot (the field named
// `publicIP`), which the bar rendered as SAFE beside an External IP of "—".

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import StatusBar from '../src/renderer/src/components/StatusBar'
import IPStatusCard from '../src/renderer/src/components/IPStatusCard'
import OverlayApp from '../src/renderer/src/OverlayApp'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

const noop = (): void => {}
let current: unknown = null

function installBridge(): void {
  const named: Record<string, Record<string, unknown>> = {
    ip: { getStatus: async () => current, onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    config: { getPrefs: async () => ({ showMarkButton: true }) },
    pivots: { getActive: async () => [], onChange: () => noop },
    events: { getCount: async () => 0, onNewBatch: () => noop },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop, onInteractive: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => false, getLastRecompute: async () => null },
    project: { active: async () => ({ createdAt: Date.now() - 60_000 }) }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

beforeEach(() => {
  window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en')
  _resetCaptureHealth(); _resetIssues(); installBridge()
})
afterEach(() => { cleanup(); current = null })

const statusBarWord = async (): Promise<string> => {
  render(<I18nProvider><StatusBar /></I18nProvider>)
  await act(async () => {})
  return screen.getByTestId('status-bar-ip-state').textContent ?? ''
}
const cardTag = async (): Promise<string> => {
  render(<I18nProvider><IPStatusCard /></I18nProvider>)
  return (await screen.findByTestId('ip-state')).textContent ?? ''
}
const hudText = async (): Promise<string> => {
  render(<I18nProvider><OverlayApp /></I18nProvider>)
  await act(async () => {})
  return document.body.textContent ?? ''
}

const cases: Array<[string, unknown]> = [
  ['no address field at all (the stub shape)', { ipSafety: 'safe', publicIP: '192.0.2.10', internalIP: '192.0.2.20', lastCheck: 0 }],
  ['a null address', { ipSafety: 'safe', externalIP: null, internalIP: '10.0.0.2', lastCheck: Date.now(), error: null }],
  ['an empty address', { ipSafety: 'safe', externalIP: '', internalIP: '10.0.0.2', lastCheck: Date.now(), error: null }]
]

describe.each(cases)('safe with %s is shown as unknown', (_name, status) => {
  beforeEach(() => { current = status })
  it('in the status bar', async () => { expect(await statusBarWord()).toBe('IP?') })
  it('on the dashboard card', async () => { expect(await cardTag()).toBe('IP status unconfirmed') })
  it('on the HUD', async () => {
    const text = await hudText()
    expect(text).toContain('IP?')
    expect(text).not.toContain('SAFE')
  })
})

describe('safe with a failed read is not shown as safe', () => {
  beforeEach(() => { current = { ipSafety: 'safe', externalIP: '198.51.100.7', internalIP: '10.0.0.2', lastCheck: Date.now(), error: 'All IP providers failed' } })
  it('in the status bar', async () => { expect(await statusBarWord()).toBe('IP?') })
  it('on the HUD', async () => {
    const text = await hudText()
    expect(text).not.toContain('SAFE')
  })
})

describe('safe with a read address stays safe', () => {
  beforeEach(() => { current = { ipSafety: 'safe', externalIP: '198.51.100.7', internalIP: '10.0.0.2', lastCheck: Date.now(), error: null } })
  it('in the status bar', async () => { expect(await statusBarWord()).toBe('SAFE') })
  it('on the dashboard card', async () => { expect(await cardTag()).toBe('On the safe IP list') })
  it('on the HUD', async () => { expect(await hudText()).toContain('SAFE') })
})
