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
  | 'unset'
  /** installed, and the operator switched it off */
  | 'off'
  /** ready to run; the proxy is not started */
  | 'stopped'
  /** the proxy process is coming up */
  | 'starting'
  /** the proxy is up — HTTP capture is operating.
   *
   *  Whether anything has come through it is not part of this: a proxy with no
   *  traffic is a proxy nobody has sent traffic to, the same way Burp's
   *  listener is simply "running". How long ago the last request landed is
   *  reported beside this, as an age, and that is where a quiet proxy shows. */
  | 'ready'
  /** the proxy could not start, or capture itself failed */
  | 'failed'

export interface HttpCaptureSource {
  installed?: boolean
  enabled?: boolean
  state: 'ready' | 'unset' | 'off' | 'error'
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
  if (!source) return proxy?.state === 'unavailable' ? 'unset' : 'stopped'

  // The operator's own choice outranks every diagnosis below it.
  if (source.state === 'off' || source.enabled === false) return 'off'
  // Evidence beats detection, and beats process state — the same rule
  // capture-health's stateFrom applies to the source row, which this function
  // used to contradict. A request that has come through proves HTTP capture
  // works, whatever the install probe believes; an operator running their own
  // mitmproxy outside RedLog has no managed process and gets exactly that
  // combination, `installed: false` over real traffic. "Not installed" is the
  // one reading this line must never give over recorded requests.
  if (source.lastEventAt !== null && source.state !== 'error') return 'ready'
  // `unavailable` is mitmdump's ENOENT, not a crash: the binary is missing.
  // Reporting that as a failure sends the operator reading an error message
  // when the answer is an install command.
  if (proxy?.state === 'unavailable' || source.installed === false) return 'unset'
  if (proxy?.state === 'failed' || source.state === 'error') return 'failed'
  if (proxy?.state === 'starting') return 'starting'
  // Up. Not "up but nothing has come through" — that distinction used to be
  // its own amber state, and it reported the operator's traffic rather than
  // RedLog's capture. The proxy either runs or it does not.
  if (proxy?.state === 'running') return 'ready'
  return 'stopped'
}
