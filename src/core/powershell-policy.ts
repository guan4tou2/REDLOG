// Why a Windows operator's own terminal records nothing while the built-in one
// records fine.
//
// Windows PowerShell 5.1 ships with `ExecutionPolicy = Restricted` on client
// SKUs. Restricted does not block commands — it blocks *scripts*, and
// `$PROFILE` is a script. So RedLog's one-click install writes its hook line
// into the profile, reports success, and the profile is never loaded: not one
// command reaches the timeline. RedLog's built-in terminal is unaffected,
// because it spawns its shell with `-ExecutionPolicy Bypass`
// (terminal-manager.ts), which is exactly what makes the failure unreadable —
// capture demonstrably works in one pane and is silent everywhere else.
//
// Preflight could not name this: its whole dependency model is python3 and
// curl, the two commands the POSIX adapter needs and win32 never uses, so on
// Windows the "what is missing" list was empty by construction.

import { execFile, execFileSync } from 'child_process'

export interface PowerShellPolicy {
  /** The shell that was asked — 5.1 and 7 can have different policies. */
  shell: string
  /** Whatever `Get-ExecutionPolicy` answered, verbatim. */
  policy: string
  blocksProfile: boolean
}

/** Scoped to the current user, and to the weakest policy that loads a local
 *  profile. `Unrestricted` and `Bypass` would also work and are not offered:
 *  this is a fix for one file the operator already agreed to, not an invitation
 *  to run anything downloaded. */
export const SET_EXECUTION_POLICY = 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'

/** Effective policies under which a dot-sourced `$PROFILE` will not run.
 *
 *  `Undefined` is in the list on purpose: when every scope is Undefined the
 *  effective policy on a Windows client is Restricted. `AllSigned` is too —
 *  the hook RedLog writes is not signed, and nothing here signs it.
 *
 *  Anything unrecognised is NOT a blocker. An answer this code does not know
 *  how to read is an unknown, and an unknown must not be reported as a cause
 *  (constitution VI). */
export function blocksProfileScripts(policy: string): boolean {
  return policy === 'Restricted' || policy === 'AllSigned' || policy === 'Undefined'
}

/** How long to wait for a shell to start and print one word. Generous: a first
 *  PowerShell start on a machine with an on-access scanner is slow. */
const PROBE_TIMEOUT_MS = 5_000

/** Ask one PowerShell for its effective policy.
 *
 *  Returns null — "not asked" — for every failure: not Windows, shell not
 *  found, spawn refused, timeout, unreadable output. Null is not "fine"; the
 *  callers render nothing rather than a cause they did not measure.
 *
 *  `-NoProfile` matters twice: the profile is the thing under test, and a
 *  profile that cannot load would otherwise make this probe as slow as the
 *  failure it is diagnosing. */
export function readExecutionPolicy(
  shell: string,
  opts: { platform?: NodeJS.Platform } = {}
): Promise<PowerShellPolicy | null> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return Promise.resolve(null)
  if (shell !== 'pwsh' && shell !== 'powershell') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const policy = String(stdout ?? '').trim()
        if (!policy || /\s/.test(policy)) return resolve(null)
        resolve({ shell, policy, blocksProfile: blocksProfileScripts(policy) })
      }
    )
  })
}

/** Where PowerShell really reads its profile from. The conventional
 *  `%USERPROFILE%\Documents\…` is wrong whenever Documents is redirected
 *  (OneDrive Known Folder Move is the common case): the hook would be written
 *  where PowerShell never looks while the UI said "installed".
 *
 *  Synchronous, because install, detect and uninstall are. Same probe shape as
 *  `readExecutionPolicy` — `-NoProfile -NonInteractive`, the same timeout,
 *  windowsHide — and the same contract: null means "not asked" (not Windows,
 *  shell missing, timeout, output that is not one absolute .ps1 path), and the
 *  caller falls back to the conventional path. */
export function readProfilePath(
  shell: string,
  opts: { platform?: NodeJS.Platform } = {}
): string | null {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return null
  if (shell !== 'pwsh' && shell !== 'powershell') return null
  try {
    const out = String(execFileSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )).trim()
    if (!out || /[\r\n]/.test(out) || !/^[A-Za-z]:[\\/]|^\\\\/.test(out) || !/\.ps1$/i.test(out)) return null
    return out
  } catch {
    return null
  }
}
