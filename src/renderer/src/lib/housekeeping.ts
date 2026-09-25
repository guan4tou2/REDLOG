// Which rows are RedLog talking to itself, and which are the operator.
//
// Housekeeping rows land in the chain for audit integrity — the record has to
// show that the app started and attached a hook — but showing them would make a
// fresh project look busy before anything has been captured. The rule itself is
// HOUSEKEEPING_SQL in src/core/db/event-queries.ts: since spec 038 every
// Timeline read (pages, counts, live admission) applies it where the rows are
// stored, so the JS copy that stood beside it is gone.

import type { RedLogEvent } from '../../../core/db/events'

export function isHookSource(cmd: unknown): boolean {
  return typeof cmd === 'string' && /shell-bash-hook\.sh|shell-zsh-hook\.zsh|shell-hook\.ps1/.test(cmd)
}

/**
 * Did the OPERATOR do this, as opposed to the app?
 *
 * Strictly narrower than "not housekeeping", and the difference is the whole
 * point: `system.ip_verdict` is a conclusion about the engagement, so the
 * timeline shows it — but the alert runtime emits one within seconds of opening
 * any project, before anything has been captured. A first-run screen keyed on
 * "not housekeeping" therefore dismisses itself immediately, on a project where
 * nothing has happened.
 *
 * The SQL twin is EVIDENCE_SQL in src/core/db/events.ts.
 */
export function isEvidence(e: RedLogEvent): boolean {
  if (e.agentType === 'system' || e.agentType === 'cleanup') return false
  const s = e.data?.subtype as string | undefined
  if (e.agentType === 'shell' && (s === 'session_start' || s === 'session_end')) return false
  if (e.agentType === 'terminal' && s === 'session_start') return false
  if (e.agentType === 'shell' && (s === 'command_start' || s === 'command' || s === 'command_end')
      && isHookSource(e.data?.command)) return false
  return true
}
