import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { classifyTier } from '../../src/core/db/events'
import { kindIds, scanInventory } from '../kinds/inventory'

// v0.13.0 two-tier chain (docs/design/DESIGN-two-tier-chain.md §11.1). Every real
// (agent_type, subtype) pair emitted anywhere in src/ must resolve to
// exactly one tier — chained or logged. Unknown pairs default to `chained`
// as the fail-safe direction.
//
// The totality check below is the important one: adding a new event
// producer without a tier decision breaks this test loudly, forcing the
// PR author to make the call explicit in LOGGED_TIER or by comment.

describe('classifyTier — v0.13 two-tier assignment', () => {
  // ─── chained tier: unchanged from pre-v0.13 ────────────────────────────

  it('shell command_start/command_end → chained', () => {
    expect(classifyTier('shell', { subtype: 'command_start' })).toBe('chained')
    expect(classifyTier('shell', { subtype: 'command_end' })).toBe('chained')
    expect(classifyTier('shell', { subtype: 'session_start' })).toBe('chained')
    expect(classifyTier('shell', { subtype: 'session_end' })).toBe('chained')
  })

  it('agent tool_call / tool_result / messages → chained', () => {
    expect(classifyTier('agent', { subtype: 'user_message' })).toBe('chained')
    expect(classifyTier('agent', { subtype: 'assistant_message' })).toBe('chained')
    expect(classifyTier('agent', { subtype: 'tool_call' })).toBe('chained')
    expect(classifyTier('agent', { subtype: 'tool_result' })).toBe('chained')
    expect(classifyTier('agent', { subtype: 'compact_summary' })).toBe('chained')
  })

  it('the scope recompute rows are chained — a prunable one would rewrite history', () => {
    // `scope_recomputed` is the anchor every retroactive row cites; a pruned
    // anchor leaves them dangling. `scope_cleared` is the ONLY record that a
    // chained violation was withdrawn — prune it and the violation silently
    // becomes active again a month later, which is a change of record with no
    // record of the change.
    expect(classifyTier('system', { subtype: 'scope_recomputed' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'scope_cleared' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'scope_violation' })).toBe('chained')
  })

  it('screenshot / marker / loot / cleanup / pivot / file_transfer → chained', () => {
    expect(classifyTier('screenshot', {})).toBe('chained')
    expect(classifyTier('marker', {})).toBe('chained')
    // An amendment (design turn 8b) is the row a reviewer asks for on its own —
    // "who changed this finding from info to critical, and when". It is also the
    // one that must not be swept: the logged tier is age-pruned after 30 days,
    // so a logged amendment would let a marker silently revert to what it used
    // to say, which is a change of record with no record of the change.
    expect(classifyTier('marker', { subtype: 'amended' })).toBe('chained')
    expect(classifyTier('loot', { subtype: 'credential_detected' })).toBe('chained')
    expect(classifyTier('cleanup', { subtype: 'history_clear' })).toBe('chained')
    expect(classifyTier('pivot', { subtype: 'socks_up' })).toBe('chained')
    expect(classifyTier('file_transfer', { subtype: 'upload' })).toBe('chained')
  })

  it('system state changes → chained', () => {
    expect(classifyTier('system', { subtype: 'recording_paused' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'config_changed' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'ip_transition' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'scope_violation' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'combined_alert' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'burst_alert' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'anchor_failed' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'chain_sample_broken' })).toBe('chained')
  })

  // ─── logged tier: v0.13 additions ──────────────────────────────────────

  it('dns query/response → logged', () => {
    expect(classifyTier('dns', { subtype: 'dns_query' })).toBe('logged')
    expect(classifyTier('dns', { subtype: 'dns_response' })).toBe('logged')
  })

  it('scanner http_* → logged', () => {
    expect(classifyTier('scanner', { subtype: 'http_request_start' })).toBe('logged')
    expect(classifyTier('scanner', { subtype: 'http_response' })).toBe('logged')
    expect(classifyTier('scanner', { subtype: 'http_error' })).toBe('logged')
    expect(classifyTier('scanner', { subtype: 'http_request_dropped' })).toBe('logged')
  })

  it('browser:console → logged — the entry is in LOGGED_TIER, but no writer writes the subtype `console` (see the CDP kinds below)', () => {
    expect(classifyTier('browser', { subtype: 'console' })).toBe('logged')
    expect(classifyTier('browser', { subtype: 'browser_launched' })).toBe('chained')
    expect(classifyTier('browser', { subtype: 'navigation' })).toBe('chained')
  })

  it('agent thinking → logged (tool_call that follows stays chained)', () => {
    expect(classifyTier('agent', { subtype: 'thinking' })).toBe('logged')
  })

  it('process spawn/exit → logged (provisional per design doc §2.3)', () => {
    expect(classifyTier('process', { subtype: 'process_spawn' })).toBe('logged')
    expect(classifyTier('process', { subtype: 'process_exit' })).toBe('logged')
  })

  it('process-monitor self-instrumentation → logged', () => {
    expect(classifyTier('system', { subtype: 'process_monitor_saturated' })).toBe('logged')
    expect(classifyTier('system', { subtype: 'process_monitor_ps_unavailable' })).toBe('logged')
  })

  // ─── ip_verdict tiering ────────────────────────────────────────────────
  // The design doc §4.1 originally reserved a data-dependent special case
  // for `ip_verdict_kind === 'unchanged'` → logged (heartbeat routing).
  // That branch was removed after review: `IPPolicy.evaluate` dedups
  // unchanged verdicts at src/core/alert/policies.ts:143 and never emits
  // one, so the special case was unreachable. Every ip_verdict event
  // that reaches insertEvent is a real state change and lands chained.

  it('system.ip_verdict → chained (every emitted verdict is a real state change)', () => {
    expect(classifyTier('system', { subtype: 'ip_verdict', ip_verdict_kind: 'exposed' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'ip_verdict', ip_verdict_kind: 'safe' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'ip_verdict', ip_verdict_kind: 'off_profile' })).toBe('chained')
    expect(classifyTier('system', { subtype: 'ip_verdict' })).toBe('chained')  // missing kind → chained too
  })

  // ─── fail-safe defaults ───────────────────────────────────────────────

  it('unknown (agent_type, subtype) → chained (fail-safe)', () => {
    expect(classifyTier('mystery-plugin', { subtype: 'trace' })).toBe('chained')
    expect(classifyTier('brand-new-source', {})).toBe('chained')
  })

  it('agent_type without subtype → chained', () => {
    expect(classifyTier('system', {})).toBe('chained')
    expect(classifyTier('shell', {})).toBe('chained')
    // Even a known logged agent_type falls back to chained without a
    // matching subtype — the classifier keys on the pair, not the
    // agent_type alone.
    expect(classifyTier('dns', {})).toBe('chained')
    expect(classifyTier('scanner', {})).toBe('chained')
  })

  it('subtype of wrong type → chained (accepts only string subtypes)', () => {
    expect(classifyTier('dns', { subtype: 42 })).toBe('chained')
    expect(classifyTier('dns', { subtype: null })).toBe('chained')
    expect(classifyTier('dns', { subtype: undefined })).toBe('chained')
  })
})

// ─── Spec 072 T010: today's tier for every kind a writer writes ─────────────────
//
// The comment above `classifyTier` (src/core/db/event-write.ts) says a
// `tier-classifier-total` test forces every written kind to have a tier. That
// test did not exist: the file above holds examples, and nothing scanned the
// writers, so a new kind got `chained` by falling off the end of the table
// without anyone having decided it. This is that check, and it pins what the
// code does today — including the one place the old examples are misleading.
//
// The kinds come from the writer inventory (test/kinds/inventory.ts, Spec 072
// T002), which reads the source; the two lists below are written out by hand so
// a NEW writer fails here until someone says which tier it belongs in. The
// code's answer is then asserted against the list, so the list cannot be wrong
// without a failure either.
//
// Browser console. `browser:console` is in LOGGED_TIER, but the CDP connector
// writes `console_log`, `console_info`, `console_warn`, `console_error`,
// `console_debug`, `console_trace`, `exception` and `log_entry`
// (src/main/services/cdp-connector.ts) — never `console`. So every real
// browser console row is CHAINED today, against docs/design/DESIGN-two-tier-chain.md §2.3
// and the report that says logged. Owner ruling Q1 (docs/records/2026-11-13/DECISIONS.md §9):
// NEW rows become logged; that is a change for Phase 4 (and a TIER_CHANGES entry),
// not something this file fixes. When it lands, move the eight kinds below to
// LOGGED_TODAY in that change.
//
// Counted 2026-11-13 on origin/main c27ed558: 137 kinds, 22 logged, 115 chained.

const LOGGED_TODAY: readonly string[] = [
  'agent:thinking', 'dns:dns_query', 'dns:dns_response', 'pcap:connection_attempt',
  'pcap:connection_established', 'pcap:connection_refused', 'pcap:port_scan', 'pcap:udp_flow',
  'process:process_exit', 'process:process_spawn', 'scanner:cookie_change', 'scanner:http_error',
  'scanner:http_request_dropped', 'scanner:http_request_start', 'scanner:http_response',
  'scanner:http_response_chunk', 'scanner:tcp_end', 'scanner:tcp_message',
  'scanner:websocket_end', 'scanner:ws_message', 'system:process_monitor_ps_unavailable',
  'system:process_monitor_saturated'
]

const CHAINED_TODAY: readonly string[] = [
  'agent:api_error', 'agent:assistant_message', 'agent:away_summary', 'agent:compact_summary',
  'agent:model_refusal', 'agent:session_end', 'agent:tool_call', 'agent:tool_interrupted',
  'agent:tool_result', 'agent:transcript_capture_started', 'agent:transcript_compacted',
  'agent:transcript_parent_missing', 'agent:transcript_schema_drift',
  'agent:transcript_snapshot', 'agent:transcript_tool_gap', 'agent:user_message',
  'browser:console_debug', 'browser:console_error', 'browser:console_info',
  'browser:console_log', 'browser:console_trace', 'browser:console_warn', 'browser:exception',
  'browser:log_entry', 'cleanup:attr_hide', 'cleanup:file_shred', 'cleanup:history_clear',
  'cleanup:log_clear', 'cleanup:timestomp', 'credential_use:api_key',
  'credential_use:auth_header', 'credential_use:basic_auth', 'credential_use:bearer_token',
  'credential_use:digest', 'credential_use:form_login', 'credential_use:negotiate',
  'credential_use:ntlm', 'credential_use:password_flag', 'credential_use:session_cookie',
  'credential_use:url_userinfo', 'file_transfer:artifact_added', 'file_transfer:download',
  'file_transfer:file_created', 'file_transfer:file_deleted', 'file_transfer:file_modified',
  'file_transfer:upload', 'http_navigation:navigation', 'loot:credential_detected', 'marker',
  'marker:amended', 'pivot:agent_connect', 'pivot:closed', 'pivot:interactive',
  'pivot:port_forward', 'pivot:proxied', 'pivot:route_add', 'pivot:socks_up',
  'pivot:tunnel_start', 'scanner:c2_checkin', 'scanner:c2_pivot', 'scanner:c2_task',
  'scanner:capture_gap', 'scanner:connection', 'scanner:connection_end', 'scanner:packet_flow',
  'scanner:pcap_segment', 'screenshot', 'shell:capture_resumed', 'shell:capture_stopped',
  'shell:command_boundary', 'shell:command_end', 'shell:command_output', 'shell:command_start',
  'shell:session_end', 'shell:session_output', 'shell:session_start', 'shell:wsl_test',
  'system:active_target_changed', 'system:agent_transcript_pruned', 'system:anchor_failed',
  'system:body_evicted', 'system:bookmarks_pruned', 'system:browser_launched',
  'system:capture_gap', 'system:cast_evicted', 'system:cast_pruned',
  'system:chain_sample_broken', 'system:config_changed', 'system:connection_capture_started',
  'system:connection_monitor_saturated', 'system:export_sealed', 'system:http_body_pruned',
  'system:http_proxy_failed', 'system:http_proxy_orphan_reclaimed', 'system:http_proxy_started',
  'system:http_proxy_stopped', 'system:ip_verdict', 'system:logged_tier_digest',
  'system:opsec_airgap', 'system:opsec_state_changed', 'system:producer_heartbeat',
  'system:recording_paused', 'system:recording_resumed', 'system:retention_pruned_logged',
  'system:sanitized', 'system:scope_cleared', 'system:scope_recomputed',
  'system:scope_violation', 'system:screenshot_deleted', 'system:screenshot_evicted',
  'system:screenshot_pruned', 'system:session_start', 'system:update_completed',
  'system:update_not_applied', 'system:update_pending'
]

describe('classifyTier — every kind a writer writes has a decided tier (Spec 072 T010)', () => {
  const found = kindIds(scanInventory(path.join(__dirname, '..', '..')).hits)
  const tierOf = (id: string): 'chained' | 'logged' => {
    const [agentType, subtype] = id.split(':')
    return classifyTier(agentType, subtype === undefined ? {} : { subtype })
  }

  it('lists every kind the writers write, and nothing they do not', () => {
    const listed = new Set([...LOGGED_TODAY, ...CHAINED_TODAY])
    expect(found.filter((k) => !listed.has(k)), 'written but with no tier decision here').toEqual([])
    expect([...listed].filter((k) => !found.includes(k)), 'listed but no longer written').toEqual([])
    expect(LOGGED_TODAY.filter((k) => CHAINED_TODAY.includes(k))).toEqual([])
  })

  it('classifies the logged ones as logged', () => {
    expect(LOGGED_TODAY.filter((k) => tierOf(k) !== 'logged')).toEqual([])
  })

  it('classifies the chained ones as chained', () => {
    expect(CHAINED_TODAY.filter((k) => tierOf(k) !== 'chained')).toEqual([])
  })

  it('every real browser console row is chained today (Q1: new rows become logged in Phase 4)', () => {
    for (const subtype of ['console_log', 'console_info', 'console_warn', 'console_error', 'console_debug', 'console_trace', 'exception', 'log_entry']) {
      expect(classifyTier('browser', { subtype }), `browser:${subtype}`).toBe('chained')
    }
    // ...while the one subtype nothing writes is the one the table names.
    expect(found.includes('browser:console')).toBe(false)
    expect(classifyTier('browser', { subtype: 'console' })).toBe('logged')
  })

  it('plugin kinds written through the local API are chained today (the plugin-credential rule is Spec 071 T027)', () => {
    for (const id of ['scanner:packet_flow', 'scanner:pcap_segment', 'scanner:c2_checkin', 'scanner:c2_task', 'scanner:c2_pivot',
      'scanner:connection', 'scanner:connection_end', 'scanner:capture_gap']) {
      expect(tierOf(id), id).toBe('chained')
    }
  })
})
