// One vocabulary for "is HTTP being recorded right now".
//
// The Dashboard used to carry two, side by side. The mitmproxy row spoke the
// capture-source language — active / idle / absent / off / error, derived from
// whether an event had landed — and a separate line above it spoke the managed
// proxy's — stopped / starting / running / unavailable / failed, derived from
// whether a process was alive. So the card could say "running" on one line and
// "idle" on the next, and leave the operator to work out that both were true
// and neither was the answer to the question they had.
//
// Worse, neither line could say the thing that actually goes wrong. A proxy
// that is up and has never had a single request routed through it is the
// normal failure of HTTP capture: nothing is misconfigured in RedLog, the
// operator's browser or tool simply is not using it, and it looks identical to
// a healthy quiet proxy. `listening` is that state, named — the same
// distinction Spec 039 draws on the first-run screen between a running proxy
// and a verified one, made permanent and put where an operator mid-engagement
// will see it.

export type HttpCaptureState =
  /** mitmproxy is not on this machine, or its addon was never installed */
  | 'absent'
  /** installed, and the operator switched it off */
  | 'off'
  /** ready to run; the proxy is not started */
  | 'stopped'
  /** the proxy process is coming up */
  | 'starting'
  /** the proxy is up and NOTHING has ever reached RedLog through it */
  | 'listening'
  /** a request or response landed inside the active window */
  | 'active'
  /** it has captured before and is quiet now */
  | 'idle'
  /** the proxy could not start, or capture itself failed */
  | 'failed'

export interface HttpCaptureSource {
  installed?: boolean
  enabled?: boolean
  state: 'active' | 'idle' | 'absent' | 'off' | 'error'
  lastEventAt: number | null
}

export interface HttpProxyStatus {
  state: 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed'
  error?: string
}

/** Derive the single HTTP capture state from the capture source row and the
 *  managed proxy, most specific condition first. */
export function httpCaptureState(
  source: HttpCaptureSource | undefined,
  proxy?: HttpProxyStatus
): HttpCaptureState {
  // A health payload without the row at all (version drift) reads as "nothing
  // is set up" rather than throwing. Readiness must never be the thing that
  // crashes the card.
  if (!source) return proxy?.state === 'unavailable' ? 'absent' : 'stopped'

  // `unavailable` is mitmdump's ENOENT, not a crash: the binary is missing.
  // Reporting that as a failure sends the operator reading an error message
  // when the answer is an install command.
  if (proxy?.state === 'unavailable' || source.installed === false) return 'absent'
  // The operator's own choice outranks every diagnosis below it.
  if (source.state === 'off' || source.enabled === false) return 'off'
  if (proxy?.state === 'failed' || source.state === 'error') return 'failed'
  if (proxy?.state === 'starting') return 'starting'
  // Events beat process state: an operator running their own mitmproxy outside
  // RedLog has no managed process, and traffic is landing regardless.
  if (source.state === 'active') return 'active'
  if (proxy?.state === 'running') return source.lastEventAt === null ? 'listening' : 'idle'
  if (proxy?.state === 'stopped') return 'stopped'
  return source.lastEventAt === null ? 'stopped' : 'idle'
}
