// Opt-in debug log (#333 had no trace to read).
//
// The switch is the existence of ~/.redlog/debug-enabled, not a config key:
// the zsh helper (redlog-session.py) runs outside the app and already reads
// ~/.redlog, and the setting is about this machine, not one project. The
// helper and the app append to the same ~/.redlog/debug.log.
//
// The log is attached to bug reports, so it records event names and counts —
// never what a command printed, a URL, a header or a path inside a project.
// Callers pass `detail` strings; keep them to ids and sizes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

const dir = (): string => path.join(os.homedir(), '.redlog')
export const debugLogPath = (): string => path.join(dir(), 'debug.log')
const flagPath = (): string => path.join(dir(), 'debug-enabled')

export function isDebugLogEnabled(): boolean {
  return fs.existsSync(flagPath())
}

export function setDebugLogEnabled(on: boolean): void {
  if (on) {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(flagPath(), '')
    debugLog('app', 'debug-log-on')
  } else {
    debugLog('app', 'debug-log-off')
    fs.rmSync(flagPath(), { force: true })
  }
}

/** Append one line when the switch is on. Never throws: logging must not
 *  change what the app does. One rotation (debug.log.1) caps disk use. */
export function debugLog(area: string, event: string, detail = ''): void {
  try {
    if (!isDebugLogEnabled()) return
    const file = debugLogPath()
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch { /* no file yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${area} ${event}${detail ? ` ${detail}` : ''}\n`)
  } catch { /* see above */ }
}
