// The two core capture capabilities, as the first-run screen and the Dashboard
// report them (#217).
//
// Commands and HTTP(S) are both core. Neither is a prerequisite for the other,
// and neither is a "mode" the operator picks: an engagement that only ever
// proves one of them is an engagement recorded with a hole in it. So each has
// its own verification, and "core capture ready" means both.
//
// What counts as verified is an event that actually arrived, not a process
// that is running or a hook that is installed on disk.

import type { RedLogEvent } from '../../../core/db/events'

type Candidate = Pick<RedLogEvent, 'agentType' | 'data'>

const COMMAND_SUBTYPES = new Set(['command_start', 'command', 'command_end'])

/** A command the operator ran, from either the built-in terminal or a shell
 *  hook. Session bookkeeping does not count: a shell that opened and ran
 *  nothing has proved nothing about command capture. */
export function isCommandEvent(ev: Candidate): boolean {
  return ev.agentType === 'shell' && COMMAND_SUBTYPES.has(ev.data?.subtype as string)
}

export function isBuiltinTerminalEvent(ev: Candidate): boolean {
  return ev.data?.source === 'builtin-terminal'
}

/** Which command path has delivered a command so far.
 *
 *  `builtin` is a verified core capability and still worth one more line: the
 *  terminal the operator normally works in is not connected yet. That is a
 *  separate fact from whether command capture works, so it is reported
 *  separately rather than holding the checkmark back. */
export type CommandsVerification = 'none' | 'builtin' | 'external'

export function commandsVerification(rows: readonly Candidate[]): CommandsVerification {
  const commands = rows.filter(isCommandEvent)
  if (commands.length === 0) return 'none'
  return commands.some((e) => !isBuiltinTerminalEvent(e)) ? 'external' : 'builtin'
}

export function coreCaptureReady(state: { commands: CommandsVerification; http: boolean }): boolean {
  return state.commands !== 'none' && state.http
}
