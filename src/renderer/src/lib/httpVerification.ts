// Spec 038: what "HTTP capture works" means. A running proxy proves only that
// mitmdump is listening; the proof is a request the addon delivered to RedLog.
// The same contract as the shell's nonce: ready → first real event → verified.

import type { RedLogEvent } from '../../../core/db/events'

type HttpCandidate = Pick<RedLogEvent, 'agentType' | 'data'>

export function isHttpCaptureEvent(ev: HttpCandidate): boolean {
  if (ev.agentType !== 'scanner') return false
  const sub = ev.data?.subtype
  return sub === 'http_request_start' || sub === 'http_response'
}

export type HttpTimeoutReason = 'browser' | 'ca' | 'terminalsOff' | 'terminalsNew'

/** Reasons that apply to this machine's state, most likely first. The browser
 *  is always listed: a browser RedLog did not launch does not use the proxy. */
export function httpTimeoutReasons(state: { certReady?: boolean; routeTerminals: boolean }): HttpTimeoutReason[] {
  const reasons: HttpTimeoutReason[] = ['browser']
  if (state.certReady === false) reasons.push('ca')
  reasons.push(state.routeTerminals ? 'terminalsNew' : 'terminalsOff')
  return reasons
}
