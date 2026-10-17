import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { applyTerminalAction, listTerminalEnrollments, writeTerminalEnrollment } from './terminal-enrollment'

// Removing a shell hook edits the rc file, and only shells started afterwards
// read it. A terminal that was already open has the hook loaded and goes on
// recording, which is the opposite of what "removed" tells the operator. Those
// terminals are stopped through the state file `redlog stop` writes, so the
// next prompt hook reads it and quits recording.

// The id a hook gives its terminal: <nanoseconds>-<shell pid>-<random>. RedLog's
// built-in terminals use other ids, and are not the hook's to stop.
const HOOK_TERMINAL_ID = /^\d{10,}-(\d+)-\d+$/

export type HookShell = 'zsh' | 'bash'

function processName(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 }).trim().split('/').pop() || null
  } catch {
    return null
  }
}

/** Stop every live terminal of this shell that is still recording. Returns how
 *  many were stopped. Never throws: a terminal we cannot touch is left running
 *  and simply not counted. */
export function stopOpenTerminals(
  shell: HookShell,
  deps: { home?: string; shellOf?: (pid: number) => string | null; platform?: NodeJS.Platform } = {}
): { stopped: number } {
  if ((deps.platform ?? process.platform) === 'win32') return { stopped: 0 }
  const home = deps.home ?? os.homedir()
  const shellOf = deps.shellOf ?? processName
  let stopped = 0
  for (const state of listTerminalEnrollments(home)) {
    if (!state.recording) continue
    const pid = HOOK_TERMINAL_ID.exec(state.sessionId)?.[1]
    if (!pid) continue
    const name = shellOf(Number(pid))?.replace(/^-/, '')
    if (name !== shell) continue
    try {
      writeTerminalEnrollment(home, applyTerminalAction(state, { type: 'stop', reason: 'hook-removed' }))
      stopped++
    } catch { /* leave it running rather than fail the removal */ }
  }
  return { stopped }
}
