// Spec 036 follow-up: turn a preflight remediation into an executable install
// plan. runtime-preflight decides WHAT is missing and the command string that
// fixes it; this decides whether RedLog may RUN that command itself, so the
// decision is unit-tested without spawning anything. mitmproxy (via uv) is the
// first dependency wired to it — the rest of the preflight set can adopt the
// same plan without new logic.
//
// RedLog runs an installer only when it is unprivileged and its own tool is
// present:
//   - a `sudo` command needs a password a spawned process cannot answer, so it
//     stays manual (the operator runs it in a terminal);
//   - a missing prerequisite (uv, brew) is surfaced so the operator installs
//     that first, rather than watching a spawn fail with ENOENT.

import type { PreflightCheck } from './runtime-preflight'

export type InstallPlan =
  | { kind: 'none'; reason: 'present' | 'no-remediation' }
  | { kind: 'needs-prereq'; prereq: { command: string; url: string } }
  | { kind: 'manual'; command: string; reason: 'elevation' }
  | { kind: 'run'; command: string; args: string[] }

export function planInstall(check: PreflightCheck): InstallPlan {
  if (check.found) return { kind: 'none', reason: 'present' }
  const remediation = check.remediation?.trim()
  if (!remediation) return { kind: 'none', reason: 'no-remediation' }
  // A missing installer (uv/brew) wins over trying to run it: the command would
  // only ENOENT, and the operator needs to be pointed at the prerequisite.
  if (check.remediationRequires) return { kind: 'needs-prereq', prereq: check.remediationRequires }
  if (/^sudo(\s|$)/.test(remediation)) return { kind: 'manual', command: remediation, reason: 'elevation' }
  const [command, ...args] = remediation.split(/\s+/)
  return { kind: 'run', command, args }
}
