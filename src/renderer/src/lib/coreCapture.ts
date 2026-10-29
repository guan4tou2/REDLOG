// The two core capture capabilities, as the first-run screen and the Dashboard
// report them (#217).
//
// Commands and HTTP(S) are both core. Neither is a prerequisite for the other,
// and neither is a "mode" the operator picks: an engagement that only ever
// proves one of them is an engagement recorded with a hole in it. So each has
// its own verification, and "core capture ready" means both delivered evidence.
// HTTP readiness proves capture, not CA trust. HttpCaptureStep reports that
// separate client-specific fact on its status label.
//
// What counts as verified is an event that actually arrived, not a process
// that is running or a hook that is installed on disk.

/** Which command path has delivered a command so far.
 *
 *  `builtin` is a verified core capability and still worth one more line: the
 *  terminal the operator normally works in is not connected yet. That is a
 *  separate fact from whether command capture works, so it is reported
 *  separately rather than holding the checkmark back. */
export type CommandsVerification = 'none' | 'builtin' | 'external'

export function commandsVerification(evidence: { builtin: boolean; external: boolean }): CommandsVerification {
  return evidence.external ? 'external' : evidence.builtin ? 'builtin' : 'none'
}

export function coreCaptureReady(state: { commands: CommandsVerification; http: boolean }): boolean {
  return state.commands !== 'none' && state.http
}
