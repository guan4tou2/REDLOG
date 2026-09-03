import { describe, it, expect } from 'vitest'
import { classifyTier } from '../../src/core/db/events'

// v0.13.0 two-tier chain (docs/DESIGN-two-tier-chain.md §11.1). Every real
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

  it('browser console → logged (browser_launched + navigation stay chained)', () => {
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
