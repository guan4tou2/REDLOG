// Open a setup-command draft beside the terminal. It is never written to a
// running PTY; the operator copies it into the intended local shell.

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
