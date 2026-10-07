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
  state: 'ready',
  lastEventAt: null,
  ...over
})
const proxy = (state: HttpProxyStatus['state']): HttpProxyStatus => ({ state })

describe('httpCaptureState', () => {
  it('says only whether the proxy is up, not whether traffic has come through', () => {
    // A proxy with no traffic is a proxy nobody has sent traffic to — the same
    // reading Burp gives its listener. Traffic is the operator's business, and
    // when it last arrived is reported beside this as an age.
    expect(httpCaptureState(src({ lastEventAt: null }), proxy('running'))).toBe('ready')
    expect(httpCaptureState(src({ lastEventAt: 1 }), proxy('running'))).toBe('ready')
  })

  it('reports a missing mitmdump as not set up, not failed', () => {
    // `unavailable` is ENOENT. The answer is an install command, not an error
    // message to read.
    expect(httpCaptureState(src(), proxy('unavailable'))).toBe('unset')
    expect(httpCaptureState(src({ installed: false }), proxy('stopped'))).toBe('unset')
  })

  it('lets the operator switch it off without calling that a problem', () => {
    expect(httpCaptureState(src({ state: 'off' }), proxy('stopped'))).toBe('off')
    // Off outranks a failure below it: the operator stopped it on purpose.
    expect(httpCaptureState(src({ state: 'off', enabled: false }), proxy('failed'))).toBe('off')
  })

  it('reports a real start failure as failed', () => {
    expect(httpCaptureState(src(), proxy('failed'))).toBe('failed')
    expect(httpCaptureState(src({ state: 'error' }), proxy('running'))).toBe('failed')
    // Even over traffic it recorded earlier: the failure is live now, and the
    // operator needs the reason, not the history.
    expect(httpCaptureState(src({ state: 'error', lastEventAt: 1 }), proxy('running'))).toBe('failed')
  })

  it('counts recorded requests over process state, for an externally run proxy', () => {
    // An operator running their own mitmproxy has no managed process at all.
    // Traffic came through; the card must not call that stopped.
    expect(httpCaptureState(src({ lastEventAt: 1 }), proxy('stopped'))).toBe('ready')
    expect(httpCaptureState(src({ lastEventAt: 1 }), undefined)).toBe('ready')
    expect(httpCaptureState(src({ lastEventAt: null }), undefined)).toBe('stopped')
  })

  it('never says "not installed" over a request that landed', () => {
    // The fixture says `installed: true`, which is why this went unnoticed:
    // mitmproxy's install probe answers false for every manual hook, so
    // `installed: false` is the reading on a healthy machine, and it sat above
    // every other branch. The card said 未安裝 mitmproxy with the proxy
    // running, the addon loaded and requests on the timeline.
    expect(httpCaptureState(src({ installed: false, lastEventAt: 1 }), proxy('running'))).toBe('ready')
    // Same rule when the probe has a reason to be wrong: an operator's own
    // mitmproxy, outside RedLog, with nothing of ours on PATH.
    expect(httpCaptureState(src({ installed: false, lastEventAt: 1 }), proxy('unavailable'))).toBe('ready')
    // Never fed and uninstalled is still unset — this only covers traffic that
    // actually came through.
    expect(httpCaptureState(src({ installed: false, lastEventAt: null }), proxy('running'))).toBe('unset')
  })

  it('shows the proxy coming up', () => {
    expect(httpCaptureState(src(), proxy('starting'))).toBe('starting')
  })

  it('survives a health payload with no mitmproxy row', () => {
    expect(httpCaptureState(undefined, proxy('running'))).toBe('stopped')
    expect(httpCaptureState(undefined, proxy('unavailable'))).toBe('unset')
    expect(httpCaptureState(undefined, undefined)).toBe('stopped')
  })

  it('never throws, whatever combination arrives', () => {
    const sourceStates: HttpCaptureSource['state'][] = ['ready', 'unset', 'off', 'error']
    const proxyStates: HttpProxyStatus['state'][] = ['stopped', 'starting', 'running', 'unavailable', 'failed']
    const valid = new Set(['unset', 'off', 'stopped', 'starting', 'listening', 'ready', 'failed'])
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
