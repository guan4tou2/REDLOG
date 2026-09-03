// Which rows are RedLog talking to itself.
//
// These land in the chain for audit integrity — the record has to show that the
// app started and attached a hook — but showing them to the operator would mean
// a fresh project looks busy before anything has been captured. Moved out of
// Timeline.tsx so the first-run strip applies exactly the same rule as the
// timeline it is a preview of; the SQL twin is HOUSEKEEPING_SQL in
// src/core/db/events.ts, and a fixture test asserts the two partition the same
// set.

import type { RedLogEvent } from '../../../core/db/events'

export function isHookSource(cmd: unknown): boolean {
  return typeof cmd === 'string' && /shell-preexec-hook\.sh/.test(cmd)
}

export function isHousekeeping(e: RedLogEvent): boolean {
  const s = e.data?.subtype as string | undefined
  if (e.agentType === 'system' && (s === 'api_started' || s === 'session_start')) return true
  // shell.session_start is redundant with session_end (which has the full
  // castPath + duration), and it fires before there's anything to replay.
  // session_end is kept visible so operators can click it and use the
  // "▶ Replay entire session" button — critical when the session ssh'd
  // into a remote host and the local command_end row only shows `ssh`.
  if (e.agentType === 'shell' && s === 'session_start') return true
  if (e.agentType === 'terminal' && s === 'session_start') return true
  if (e.agentType === 'shell' && (s === 'command_start' || s === 'command') && isHookSource(e.data?.command)) return true
  return false
}

/**
 * Did the OPERATOR do this, as opposed to the app?
 *
 * Strictly narrower than `!isHousekeeping`, and the difference is the whole
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
