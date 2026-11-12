// The renderer's half of the terminal's output path (main: terminal-output.ts).

import { ACK_EVERY_CHARS } from '../../../main/terminal-output'

/** Acknowledge parsed output to main in steps of ACK_EVERY_CHARS, so a flood
 *  is not answered with one IPC message per write. What is left under a step
 *  stays below main's low-water mark and never holds the pty paused. */
export function createAckBatcher(send: (chars: number) => void, every = ACK_EVERY_CHARS): (chars: number) => void {
  let parsed = 0
  return (chars) => {
    parsed += chars
    if (parsed < every) return
    send(parsed)
    parsed = 0
  }
}

/** Fit the terminal once the pane has stopped changing size for `delayMs`. A
 *  ResizeObserver reports every frame of a window drag; each fit was a
 *  `terminal:resize`, a pty resize (SIGWINCH to the shell, which redraws) and
 *  a resize frame in the recording. */
export function createFitScheduler(fit: () => void, delayMs = 60, frame: (cb: () => void) => unknown = (cb) => requestAnimationFrame(() => cb())): {
  schedule: () => void
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; frame(fit) }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
