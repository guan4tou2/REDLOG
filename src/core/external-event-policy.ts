// Which events an outside tool may post to POST /api/events. Pure, so the rule
// is testable without binding a port.

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
 *  audit row and stays refused. */
function isProducerHeartbeat(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const d = data as Record<string, unknown>
  const keys = Object.keys(d)
  return keys.length === 2
    && d.subtype === 'producer_heartbeat'
    && typeof d.producer === 'string'
    && PRODUCER_ID_RE.test(d.producer)
}

export function isExternalEventAllowed(agentType: string, data: unknown): boolean {
  if (EXTERNAL_ALLOWED_AGENT_TYPES.has(agentType)) return true
  return agentType === 'system' && isProducerHeartbeat(data)
}
