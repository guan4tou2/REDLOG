// Send a setup command to RedLog's own terminal instead of the clipboard.
//
// Every manual capture source hands the operator a command to paste somewhere
// else. Two things are lost when they do: the terminal they paste into is not
// the one RedLog records, so setting capture up is the one part of an
// engagement that leaves no trace; and a copy button cannot tell whether the
// command was ever run, which is why a source can sit at "not installed"
// while the operator is sure they did it.
//
// The command is TYPED, not executed. Some of these start long-running
// processes and some kill them by PID; the operator reads the line and presses
// Enter. RedLog's shell hook then records it like any other command, so the
// setup is part of the log it was setting up.

const EVENT = 'redlog:run-in-terminal'

/** Set when the request arrives before the terminal view has mounted, which
 *  is the normal case: the request comes from Settings. */
let pending: string | null = null

export function requestRunInTerminal(command: string): void {
  pending = command
  window.dispatchEvent(new CustomEvent(EVENT, { detail: command }))
}

/** The command waiting for a terminal, cleared as it is handed over. */
export function takePendingCommand(): string | null {
  const c = pending
  pending = null
  return c
}

/** For a terminal view that is already mounted when the request arrives. */
export function onRunInTerminal(handler: (command: string) => void): () => void {
  const listener = (e: Event): void => {
    const command = (e as CustomEvent<string>).detail
    if (typeof command === 'string' && command) handler(command)
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
