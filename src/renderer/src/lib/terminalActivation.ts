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
 *  hooked. */
const DEPENDENCIES = ['python3', 'curl']

export function missingDependencies(preflight: RuntimePreflight | null): RuntimePreflight['checks'] {
  if (!preflight) return []
  return preflight.checks.filter((c) => DEPENDENCIES.includes(c.id) && !c.found)
}

export function activationNonce(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function activationCommand(nonce: string): string {
  return `echo redlog-ok-${nonce}`
}

type ActivationCandidate = Pick<RedLogEvent, 'agentType' | 'data'>

export function isActivationEvent(ev: ActivationCandidate, nonce: string): boolean {
  if (ev.agentType !== 'shell') return false
  const d = ev.data ?? {}
  if (d.subtype !== 'command_start' && d.subtype !== 'command_end') return false
  if (d.source === 'builtin-terminal') return false
  return typeof d.command === 'string' && d.command.includes(`redlog-ok-${nonce}`)
}

const SHELL_LABELS: Record<string, string> = { zsh: 'Zsh', bash: 'Bash', pwsh: 'PowerShell', powershell: 'PowerShell' }

export function shellLabel(name: string): string {
  return SHELL_LABELS[name] ?? name
}
