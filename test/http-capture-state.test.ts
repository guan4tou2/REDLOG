// One vocabulary for HTTP capture: what the Dashboard says when the proxy is
// up, down, missing, or up and quietly recording nothing.
import { describe, it, expect } from 'vitest'
import {
  httpCaptureState,
  type HttpCaptureSource,
  type HttpProxyStatus
} from '../src/renderer/src/lib/httpCaptureState'

const src = (over: Partial<HttpCaptureSource> = {}): HttpCaptureSource => ({
  installed: true,
  state: 'idle',
  lastEventAt: null,
  ...over
})
const proxy = (state: HttpProxyStatus['state']): HttpProxyStatus => ({ state })

describe('httpCaptureState', () => {
  it('names the state that used to be invisible: up, and nothing has ever come through', () => {
    // The normal failure of HTTP capture. Nothing in RedLog is misconfigured —
    // the operator's browser or tool simply is not using the proxy — and on
    // the old card it looked exactly like a healthy quiet proxy: one line said
    // "running", the next said "idle".
    expect(httpCaptureState(src({ lastEventAt: null }), proxy('running'))).toBe('listening')
    // Once anything has come through, quiet is just quiet.
    expect(httpCaptureState(src({ lastEventAt: 1 }), proxy('running'))).toBe('idle')
  })

  it('reports a missing mitmdump as absent, not failed', () => {
    // `unavailable` is ENOENT. The answer is an install command, not an error
    // message to read.
    expect(httpCaptureState(src(), proxy('unavailable'))).toBe('absent')
    expect(httpCaptureState(src({ installed: false }), proxy('stopped'))).toBe('absent')
  })

  it('lets the operator switch it off without calling that a problem', () => {
    expect(httpCaptureState(src({ state: 'off', enabled: false }), proxy('stopped'))).toBe('off')
    // Off outranks a failure below it: the operator stopped it on purpose.
    expect(httpCaptureState(src({ state: 'off', enabled: false }), proxy('failed'))).toBe('off')
  })

  it('reports a real start failure as failed', () => {
    expect(httpCaptureState(src(), proxy('failed'))).toBe('failed')
    expect(httpCaptureState(src({ state: 'error' }), proxy('running'))).toBe('failed')
  })

  it('counts events over process state, for an externally run proxy', () => {
    // An operator running their own mitmproxy has no managed process at all.
    // Traffic is landing; the card must not call that stopped.
    expect(httpCaptureState(src({ state: 'active', lastEventAt: 1 }), proxy('stopped'))).toBe('active')
    expect(httpCaptureState(src({ state: 'idle', lastEventAt: 1 }), undefined)).toBe('idle')
    expect(httpCaptureState(src({ lastEventAt: null }), undefined)).toBe('stopped')
  })

  it('shows the proxy coming up', () => {
    expect(httpCaptureState(src(), proxy('starting'))).toBe('starting')
  })

  it('survives a health payload with no mitmproxy row', () => {
    expect(httpCaptureState(undefined, proxy('running'))).toBe('stopped')
    expect(httpCaptureState(undefined, proxy('unavailable'))).toBe('absent')
    expect(httpCaptureState(undefined, undefined)).toBe('stopped')
  })

  it('never throws, whatever combination arrives', () => {
    const sourceStates: HttpCaptureSource['state'][] = ['active', 'idle', 'absent', 'off', 'error']
    const proxyStates: HttpProxyStatus['state'][] = ['stopped', 'starting', 'running', 'unavailable', 'failed']
    const valid = new Set(['absent', 'off', 'stopped', 'starting', 'listening', 'active', 'idle', 'failed'])
    for (const s of sourceStates) {
      for (const p of proxyStates) {
        for (const installed of [true, false, undefined]) {
          for (const last of [null, 1]) {
            expect(valid).toContain(httpCaptureState(src({ state: s, installed, lastEventAt: last }), proxy(p)))
          }
        }
      }
    }
  })
})
