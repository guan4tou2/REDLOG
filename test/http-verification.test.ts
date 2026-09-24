// Spec 039: what counts as "HTTP traffic reached RedLog", and which reasons
// apply when it has not.
import { describe, it, expect } from 'vitest'
import { isHttpCaptureEvent, httpTimeoutReasons } from '../src/renderer/src/lib/httpVerification'

describe('isHttpCaptureEvent', () => {
  it('accepts request and response events from the proxy', () => {
    expect(isHttpCaptureEvent({ agentType: 'scanner', data: { subtype: 'http_request_start' } })).toBe(true)
    expect(isHttpCaptureEvent({ agentType: 'scanner', data: { subtype: 'http_response' } })).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isHttpCaptureEvent({ agentType: 'scanner', data: { subtype: 'port_scan' } })).toBe(false)
    expect(isHttpCaptureEvent({ agentType: 'shell', data: { subtype: 'http_request_start' } })).toBe(false)
    expect(isHttpCaptureEvent({ agentType: 'scanner', data: {} as Record<string, unknown> })).toBe(false)
  })
})

describe('httpTimeoutReasons', () => {
  it('always names the browser; the CA only when it is not ready; terminals by the routing switch', () => {
    expect(httpTimeoutReasons({ certReady: true, routeTerminals: false })).toEqual(['browser', 'terminalsOff'])
    expect(httpTimeoutReasons({ certReady: false, routeTerminals: true })).toEqual(['browser', 'ca', 'terminalsNew'])
    expect(httpTimeoutReasons({ certReady: undefined, routeTerminals: true })).toEqual(['browser', 'terminalsNew'])
  })
})
