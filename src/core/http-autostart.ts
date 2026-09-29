// Should opening a project start HTTP capture?
//
// The "Start HTTP capture" button was the operator telling RedLog to do the
// one thing it was already there to do. Command capture never asks; the shell
// hook records from the moment a project is open. HTTP capture asked because
// starting it spawns a process and binds a port — but it changes nothing else:
// RedLog never touches the system proxy settings, so no traffic on the machine
// moves until the operator launches the capture browser or opts terminals in.
//
// So it starts itself, once, when a project opens. What it must not do is
// retry in a loop, or write a failure event into every engagement on a machine
// that has no mitmproxy: a project opening is not the moment to report a
// dependency the operator may never need.

import type { ManagedProxyState } from '../main/services/managed-http-proxy'

export interface AutoStartInput {
  /** mitmdump resolves on PATH. False means the operator has not installed it. */
  mitmdumpOnPath: boolean
  /** The proxy's state at the moment the project opened. */
  state: ManagedProxyState
}

/** True only for the one case worth acting on: the runtime is there and
 *  nothing is running yet.
 *
 *  - `running` / `starting`: already the wanted outcome.
 *  - `failed` / `unavailable`: a previous attempt said why. Opening a project
 *    is not new information, and repeating a failure the operator has already
 *    read is noise, not diagnosis. */
export function shouldAutoStartHttpCapture({ mitmdumpOnPath, state }: AutoStartInput): boolean {
  return mitmdumpOnPath && state === 'stopped'
}
