// Which events an outside tool may post to POST /api/events. Pure, so the rule
// is testable without binding a port.

import { RESERVED_DATA_KEYS } from './ingest/stamp'

/** Types an outside tool may report. The ones deliberately absent are
 *  derived — `system`, `pivot`, `cleanup`, `loot`, `scope_violation` are
 *  written by RedLog's own analysis, and letting a caller forge them
 *  means forging RedLog's conclusions about the engagement.
 *
 *  `terminal` is here because it is the type in redlog-cli's own help
 *  text (`redlog-cli log terminal --data ...`). Leaving it out 403'd the
 *  documented path; e2e/cli-smoke.spec.ts caught it. */
const EXTERNAL_ALLOWED_AGENT_TYPES: ReadonlySet<string> = new Set([
  'scanner', 'shell', 'terminal', 'dns', 'external', 'agent', 'marker',
  'process', 'credential_use', 'file_transfer', 'screenshot',
  'browser', 'http_navigation',
  // v0.15: out-of-process pcap producer (hooks/pcap-agent.py) — connection
  // attempts / SYN scans / non-proxied flow metadata the app-layer proxy
  // and the established-only connection monitor can't see.
  'pcap'
])

const PRODUCER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The one `system` event an outside producer may post: a liveness beat that
 *  capture-health reads (`system.producer_heartbeat`, keyed on `producer`).
 *  Exactly these two fields — anything else under `system` is RedLog's own
 *  audit row and stays refused. The receiver-owned keys are not counted:
 *  ingest() takes them out before anything reads `data` (Spec 071 FR-090), so
 *  the policy judges the row as it will be stored. */
function isProducerHeartbeat(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const d = data as Record<string, unknown>
  const keys = Object.keys(d).filter((k) => !(RESERVED_DATA_KEYS as readonly string[]).includes(k))
  return keys.length === 2
    && d.subtype === 'producer_heartbeat'
    && typeof d.producer === 'string'
    && PRODUCER_ID_RE.test(d.producer)
}

export function isExternalEventAllowed(agentType: string, data: unknown): boolean {
  if (EXTERNAL_ALLOWED_AGENT_TYPES.has(agentType)) return true
  return agentType === 'system' && isProducerHeartbeat(data)
}

/** Who is writing, as far as the receiver can tell before Spec 071's
 *  credentials exist (FR-071 names the classes that come with them).
 *
 *  - `legacy`: the bearer of today's per-project token on POST /api/events.
 *    What it may write is `isExternalEventAllowed` plus the API's own refusal
 *    of a marker amendment; the API answers those with two different 403s, so
 *    it keeps its two checks and this table records that they are one policy.
 *  - `legacy-handoff`: a file in ~/.redlog/pending. It carries no credential at
 *    all — any process running as the operator can put one there — so it gets
 *    the narrowest scope: no `system` of any kind (not even the heartbeat, which
 *    no spooling producer sends), no derived kind, and no `marker` (FR-065: a
 *    marker only from a credential whose scope names it). */
export type ProducerClass = 'legacy' | 'legacy-handoff'

const KIND_POLICY: Readonly<Record<ProducerClass, (agentType: string, data: unknown) => boolean>> = {
  legacy: (agentType, data) => isExternalEventAllowed(agentType, data)
    && !(agentType === 'marker' && (data as Record<string, unknown> | null)?.subtype === 'amended'),
  'legacy-handoff': (agentType) => agentType !== 'marker' && EXTERNAL_ALLOWED_AGENT_TYPES.has(agentType)
}

/** May `producer` write an event of this kind? Every door that is not RedLog's
 *  own asks this; the spool drain is the one that did not (Spec 071 T010). */
export function isKindAllowed(producer: ProducerClass, agentType: string, data: unknown): boolean {
  return KIND_POLICY[producer](agentType, data)
}
