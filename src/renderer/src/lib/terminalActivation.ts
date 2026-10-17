// Spec 037: what "this terminal is connected" means, kept out of the component
// so it can be read — and tested — on its own.
//
// An installed hook proves nothing: the profile may not be sourced yet, python3
// may be gone, a retired hook line may shadow it. The only proof is an event
// from that terminal. So each attempt gets a short random nonce, the operator
// runs `echo redlog-ok-<nonce>` in a NEW tab, and the attempt is verified when
// a shell command event carrying that nonce arrives from anywhere except the
// built-in terminal (which has its own capture path and proves nothing about
// the operator's terminal).

import type { RedLogEvent } from '../../../core/db/events'

/** The POSIX adapters build events with python3 and send them with curl. The
 *  shell binaries in preflight are not dependencies — they are the thing being
 *  hooked. Used only when no adapter was named, so Settings' machine-wide
 *  readiness view keeps its old meaning. */
const DEPENDENCIES = ['python3', 'curl']

/** What is missing for one adapter, or for the POSIX pair when none is named.
 *
 *  The adapter is the point: bash and zsh share python3/curl, but PowerShell
 *  needs neither and must not be shown blocked by them, and a host that has
 *  only one of the two POSIX shells should not have the other's prerequisites
 *  read as the chosen one's. The answer comes from preflight's own `neededFor`
 *  rather than a second table here, so the two cannot drift. */
export function missingDependencies(
  preflight: RuntimePreflight | null,
  hookId?: string
): RuntimePreflight['checks'] {
  if (!preflight) return []
  if (hookId === 'shell-powershell') {
    const shells = preflight.checks.filter((c) => c.id === 'powershell' || c.id === 'pwsh')
    if (shells.some((c) => c.found)) return []
    return shells.length ? [shells.find((c) => c.id === preflight.shell?.name) ?? shells[0]] : []
  }
  return preflight.checks.filter((c) =>
    !c.found && (hookId ? c.neededFor.includes(hookId) : DEPENDENCIES.includes(c.id))
  )
}

/** The shell language an adapter speaks.
 *
 *  `shell-powershell` covers Windows PowerShell 5.1 and PowerShell 7: they
 *  load different profiles but both write `shell: 'powershell'` into their
 *  events, so they are one language with two editions, not two adapters. */
export type ShellName = 'zsh' | 'bash' | 'powershell'

interface HostAdapter {
  hookId: string
  shell: ShellName
  label: string
}

// Fixed adapters only. The installer knows exactly these profiles, so a
// "custom executable path" box would offer something the backend cannot
// honour — a recorded command from a wrapper RedLog never installed. That is
// future work with its own backend support, not a field invented here.
const HOST_ADAPTERS: Record<string, HostAdapter> = {
  'shell-zsh': { hookId: 'shell-zsh', shell: 'zsh', label: 'Zsh' },
  'shell-bash': { hookId: 'shell-bash', shell: 'bash', label: 'Bash' },
  'shell-powershell': { hookId: 'shell-powershell', shell: 'powershell', label: 'PowerShell' }
}

/** The shell language a hook id installs, or null when it is not a shell. */
export function shellNameForHook(hookId: string | null | undefined): ShellName | null {
  return hookId ? HOST_ADAPTERS[hookId]?.shell ?? null : null
}

export interface AdapterChoice {
  hookId: string
  shell: ShellName
  label: string
  /** `hooks.detect()`'s answer — an unavailable adapter cannot record, whatever
   *  the install reports, so it is never offered as connected. */
  available: boolean
  installed: boolean
}

/** A hook as `hooks.detect()` reports it, reduced to what the picker reads.
 *  Structural on purpose: the renderer's `HookInfo` already has these fields,
 *  and importing the Settings type into a lib would couple the two. */
interface DetectedHook {
  id: string
  available: boolean
  installed: boolean
  disabled?: boolean
}

/** The shell adapters to offer on this host, in the order to show them.
 *
 *  Derived from `hooks.detect()`, never invented: an id the backend does not
 *  report is left out (there is nothing to install), and `available` is the
 *  same answer Settings' hook list shows. Windows PowerShell is first on
 *  win32 — it is what an unconfigured install lands on — and zsh first on
 *  POSIX. WSL is deliberately absent: it is an environment RedLog supports,
 *  not a fourth shell language, and it keeps its own distro flow. */
export function hostAdapterChoices(hooks: DetectedHook[], platform: string): AdapterChoice[] {
  const order = platform === 'win32'
    ? ['shell-powershell', 'shell-bash']
    : ['shell-zsh', 'shell-bash']
  const byId = new Map(hooks.map((h) => [h.id, h]))
  const out: AdapterChoice[] = []
  for (const id of order) {
    const adapter = HOST_ADAPTERS[id]
    const hook = byId.get(id)
    if (!adapter || !hook || hook.disabled) continue
    out.push({
      hookId: id,
      shell: adapter.shell,
      label: adapter.label,
      available: hook.available === true,
      installed: hook.installed === true
    })
  }
  return out
}

/** What is stopping the operator's own terminal from recording, if anything.
 *
 *  This used to be `missingDependencies` alone, which made "what is wrong" a
 *  question only POSIX could answer: win32 preflight checks neither python3
 *  nor curl, so the list was empty on every Windows machine — working or
 *  broken — and the screen fell back to a timer that says nothing is arriving.
 *  The Windows cause is not a missing command at all; it is a policy that
 *  stops `$PROFILE` from loading (see core/powershell-policy.ts). */
export type CaptureBlocker =
  | { kind: 'missing-command'; check: RuntimePreflight['checks'][number] }
  | { kind: 'execution-policy'; policy: string; remediation: string }

/** The fix, duplicated from core/powershell-policy.ts so the renderer does not
 *  import a module that spawns processes. The test asserts they agree. */
export const SET_EXECUTION_POLICY = 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'

export function commandCaptureBlockers(
  preflight: RuntimePreflight | null,
  hookId?: string
): CaptureBlocker[] {
  if (!preflight) return []
  const ps = preflight.powershell
  // The policy only ever stops the PowerShell adapter: a POSIX hook is loaded
  // from an rc file, not `$PROFILE`, so a Restricted policy says nothing about
  // it. Named adapter first; no adapter means the machine-wide view, which
  // still reports the one Windows cause that is not a missing command.
  const powershellRelevant = hookId === undefined || hookId === 'shell-powershell'
  // `null` is "not measured", not "measured and fine": naming a cause that was
  // never observed is the same failure as hiding one that is.
  if (ps?.blocksProfile && powershellRelevant) {
    return [{ kind: 'execution-policy', policy: ps.policy, remediation: SET_EXECUTION_POLICY }]
  }
  return missingDependencies(preflight, hookId).map((check) => ({ kind: 'missing-command', check }))
}

export function activationNonce(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The command that proves the operator's own terminal reaches RedLog.
 *
 *  The nonce is hex, so it needs no quoting in any of the three shells. The
 *  spelling differs only where the shell's own words do: PowerShell's `echo`
 *  is an alias for Write-Output, and saying the alias when the shell has a
 *  real verb is how a copied line stops looking like something typed into
 *  PowerShell. */
export function activationCommand(nonce: string, shell?: ShellName | null): string {
  if (shell === 'powershell') return `Write-Output redlog-ok-${nonce}`
  return `echo redlog-ok-${nonce}`
}

type ActivationCandidate = Pick<RedLogEvent, 'agentType' | 'data'>

export function isActivationEvent(ev: ActivationCandidate, nonce: string, shell: ShellName | null, wslDistro: string | null): boolean {
  if (ev.agentType !== 'shell') return false
  const d = ev.data ?? {}
  if (d.subtype !== 'command_start' && d.subtype !== 'command_end') return false
  if (d.source === 'builtin-terminal') return false
  // A nonce alone cannot establish the selected adapter's identity.
  if (shell && (typeof d.shell !== 'string' || d.shell.toLowerCase() !== shell)) return false
  if (wslDistro ? d.wsl_distro !== wslDistro : Boolean(d.wsl_distro)) return false
  return typeof d.command === 'string' && d.command.includes(`redlog-ok-${nonce}`)
}

const SHELL_LABELS: Record<string, string> = { zsh: 'Zsh', bash: 'Bash', pwsh: 'PowerShell', powershell: 'PowerShell' }

export function shellLabel(name: string): string {
  return SHELL_LABELS[name] ?? name
}
