// @vitest-environment jsdom
//
// Seen on the dashboard: 「指令已接入，HTTP 代理啟動失敗」, the HTTP(S) row
// in 失敗 with a red error, and the verdict badge green 「擷取狀態正常」. The
// error under it was main's English sentence in a zh-TW UI.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { I18nProvider } from '../src/renderer/src/i18n'

const MESSAGE = '127.0.0.1:6661 is already in use by mitmdump (PID 4242). Change the HTTP capture port in Settings → Browser, or stop what is using it.'
const capture = (verdict: 'healthy' | 'partial'): CaptureHealthInfo => ({
  verdict, hasRecorded: true, lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null,
  sources: [
    { id: 'terminal', label: 'Terminal', state: 'ready', installed: true, lastEventAt: Date.now() },
    { id: 'mitmproxy', label: 'HTTP', state: 'ready', installed: true, lastEventAt: null }
  ],
  managedHttpProxy: {
    state: 'failed', url: null, error: MESSAGE,
    errorReason: { code: 'port-in-use', address: '127.0.0.1:6661', holder: 'mitmdump (PID 4242)' }
  }
} as unknown as CaptureHealthInfo)

const show = (c: CaptureHealthInfo): void => {
  render(<I18nProvider><CaptureHealthCard capture={c} onNavigate={() => {}} onRefresh={() => {}} /></I18nProvider>)
}
beforeEach(() => {
  window.localStorage.clear()
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => undefined }) })
})
afterEach(cleanup)

it('does not wear the healthy badge over a proxy that failed to start', () => {
  window.localStorage.setItem('redlog-locale', 'en')
  // Even a verdict computed as healthy: the card can see the failure itself.
  show(capture('healthy'))
  const badge = screen.getByTestId('capture-verdict')
  expect(badge.textContent).toContain('Some sources report problems')
  expect(badge.textContent).not.toContain('Capture is working')
})

it('words the port-in-use failure in the UI language, from its code', () => {
  window.localStorage.setItem('redlog-locale', 'zh-TW')
  show(capture('partial'))
  expect(screen.getByText('127.0.0.1:6661 已被 mitmdump (PID 4242) 佔用。請到「設定 → 瀏覽器與 HTTP 擷取」變更 HTTP 擷取埠，或停止佔用它的程式。')).toBeTruthy()
  expect(screen.queryByText(MESSAGE)).toBeNull()
})
