// @vitest-environment jsdom
//
// Spec 072 T008 (US2, SC-004) — every kind a writer writes has a title of its
// own and is opened by a reader that fits it.
//
// Two questions per example row (examples.ts), both asked of today's code:
//
//   TITLE   `eventTitle(row)` must not take a fallback branch: `eventTitle.shellEvent`,
//           `eventTitle.systemOther`, `agent: <subtype>`, `<agent_type>: <subtype>`,
//           or the scanner's `[<subtype>] …`. Those print the raw subtype, which
//           is what the operator sees instead of what happened.
//   READER  the reader the Timeline inspector opens (`eventReader`, plus the
//           ten-value `ReaderId` of FR-030 it will become) must be the one that
//           fits the kind. Today `eventReader` has nine values and the default
//           is `generic`, which is the right answer for a kind that has no
//           content and the wrong one for a kind that falls there only because
//           nobody wrote its branch. EXPECTED_READER states which is which, per
//           kind, from FR-030's table; it is this test's reading of that table
//           and Phase 2's registry replaces it.
//
// The cases that fail today are written as the correct expectation and marked
// `it.fails`, listed by id in RED_TITLE and RED_READER below. The lists are
// explicit so that fixing a kind makes its case pass, `it.fails` then fails,
// and the id has to be removed from the list — a fix cannot go unnoticed and a
// regression cannot hide among the failures that are already expected.
//
// The spec counts 29 kinds with a raw title (report 10, A.3) and a screenshot
// with no reader. Main moved since: #591 and the reader commit 1febccf9 gave
// titles to pcap, c2, agent refusals and others, and `eventReader` now returns
// `image` for a screenshot. The lists here are what the code does on
// 2026-11-13; the difference from 29 is reported with the run.
import { describe, expect, it } from 'vitest'
import { englishTitle, eventTitle } from '../../src/renderer/src/lib/eventTitle'
import { eventReader, type EventReader } from '../../src/renderer/src/lib/timelineEvents'
import { EXAMPLES, type Example } from './examples'

// ── title ───────────────────────────────────────────────────────────────────

function fallback(e: Example): string | null {
  const used: string[] = []
  const title = eventTitle(e.row, (k, v) => { used.push(k); return englishTitle(k, v) })
  if (used.includes('eventTitle.shellEvent')) return 'eventTitle.shellEvent (the shell fallback)'
  if (used.includes('eventTitle.systemOther')) return 'eventTitle.systemOther (the system fallback)'
  const sub = String(e.row.data.subtype ?? '')
  if (title === `${e.row.agentType}: ${sub}` || title === `agent: ${sub}`) return `"${title}" (the raw agent_type: subtype fallback)`
  if (e.row.agentType === 'scanner' && sub && title.startsWith(`[${sub}]`)) return `"${title}" (the scanner fallback)`
  return null
}

/** Example ids whose title takes a fallback today. Measured 2026-11-13 on origin/main c27ed558. */
const RED_TITLE: readonly string[] = [
  'pcap:connection_attempt',
  'pcap:connection_established',
  'pcap:connection_refused',
  'pcap:port_scan',
  'pcap:udp_flow',
  'scanner:capture_gap',
  'scanner:http_response_chunk',
  'scanner:websocket_end',
  'shell:command_output',
  'shell:wsl_test',
  'system:active_target_changed',
  'system:agent_transcript_pruned',
  'system:anchor_failed',
  'system:bookmarks_pruned',
  'system:cast_evicted',
  'system:cast_pruned',
  'system:export_sealed',
  'system:http_body_pruned',
  'system:logged_tier_digest',
  'system:process_monitor_ps_unavailable',
  'system:process_monitor_saturated',
  'system:producer_heartbeat',
  'system:screenshot_deleted',
  'system:screenshot_evicted',
  'system:screenshot_pruned',
  'system:update_completed',
  'system:update_not_applied',
  'system:update_pending',
  'shell:command_output#streamed',
  'shell:command_output#foreground',
  'scanner:capture_gap#inflight',
  'system:api_started#legacy',
  'terminal:session_start#legacy'
]

/** Rows that stand for a kind no registry will name (an unknown agent:* subtype, the external:* / terminal:*
 *  families, a kind only a plugin manifest can declare). Their fallback title is the right answer: the registry
 *  gives them `unregistered` or the plugin's label, not a title of their own. */
const UNREGISTERED: readonly string[] = [
  'agent:future_subtype#unknown-subtype', 'agent:system#open-branch', 'external:note#external-family',
  'terminal:command#cli-help-text', 'plugin-kind:probe#plugin-declared'
]

describe('every example has a title of its own (US2, SC-004)', () => {
  for (const e of EXAMPLES.filter((x) => !UNREGISTERED.includes(x.id))) {
    const run = (): void => { expect(fallback(e), `${e.id}: the title falls back`).toBeNull() }
    if (RED_TITLE.includes(e.id)) it.fails(`${e.id}`, run)
    else it(`${e.id}`, run)
  }

  it('lists no id that is not an example', () => {
    expect(RED_TITLE.filter((id) => !EXAMPLES.some((e) => e.id === id))).toEqual([])
  })
})

// ── reader ──────────────────────────────────────────────────────────────────

type ReaderId = 'text-output' | 'terminal-recording' | 'http-exchange' | 'image' | 'file' | 'packet-flow' | 'ai-transcript' | 'record-fact' | 'note' | 'fields'

/** Today's nine dispatch values, in FR-030's ten. `generic` is `fields`; `record-fact` has no dispatch value yet. */
const TODAY: Record<EventReader, ReaderId> = {
  command: 'text-output', session: 'terminal-recording', 'agent-turn': 'ai-transcript', http: 'http-exchange',
  console: 'text-output', marker: 'note', image: 'image', artifact: 'file', generic: 'fields'
}

const CONVERSATION = new Set(['user_message', 'assistant_message', 'thinking', 'tool_call', 'tool_result', 'tool_interrupted', 'compact_summary', 'away_summary', 'model_refusal', 'api_error'])
const HTTP = new Set(['http_request_start', 'http_response', 'http_response_chunk', 'http_error', 'http_request_dropped', 'ws_message', 'websocket_end', 'tcp_message', 'tcp_end'])

/** The reader FR-030 gives each kind. */
export function expectedReader(kind: string): ReaderId {
  const [type, sub = ''] = kind.split(':')
  switch (type) {
    case 'shell':
      if (['command_start', 'command_end', 'command_output', 'session_output', 'command'].includes(sub)) return 'text-output'
      if (sub === 'session_start' || sub === 'session_end') return 'terminal-recording'
      return 'record-fact'
    case 'agent': return CONVERSATION.has(sub) ? 'ai-transcript' : 'record-fact'
    case 'scanner':
      if (HTTP.has(sub)) return 'http-exchange'
      if (sub === 'pcap_segment') return 'file'
      if (sub === 'capture_gap') return 'record-fact'
      if (sub === 'cookie_change') return 'fields'
      return 'packet-flow'
    case 'pcap': return 'packet-flow'
    case 'browser': return 'text-output'
    case 'marker': return 'note'
    case 'screenshot': return 'image'
    case 'file_transfer': return sub === 'upload' || sub === 'download' ? 'fields' : 'file'
    case 'system': return 'record-fact'
    default: return 'fields'
  }
}

/** Default rows whose reader is not the one FR-030 gives the kind, today. */
const RED_READER: readonly string[] = [
  'agent:api_error',
  'agent:model_refusal',
  'agent:session_end',
  'agent:transcript_capture_started',
  'agent:transcript_compacted',
  'agent:transcript_parent_missing',
  'agent:transcript_schema_drift',
  'agent:transcript_snapshot',
  'agent:transcript_tool_gap',
  'file_transfer:file_created',
  'file_transfer:file_deleted',
  'file_transfer:file_modified',
  'pcap:connection_attempt',
  'pcap:connection_established',
  'pcap:connection_refused',
  'pcap:port_scan',
  'pcap:udp_flow',
  'scanner:c2_checkin',
  'scanner:c2_pivot',
  'scanner:c2_task',
  'scanner:capture_gap',
  'scanner:connection',
  'scanner:connection_end',
  'scanner:packet_flow',
  'scanner:pcap_segment',
  'shell:capture_resumed',
  'shell:capture_stopped',
  'shell:command_boundary',
  'shell:command_output',
  'shell:session_output',
  'shell:wsl_test',
  'system:active_target_changed',
  'system:agent_transcript_pruned',
  'system:anchor_failed',
  'system:body_evicted',
  'system:bookmarks_pruned',
  'system:browser_launched',
  'system:capture_gap',
  'system:cast_evicted',
  'system:cast_pruned',
  'system:chain_sample_broken',
  'system:config_changed',
  'system:connection_capture_started',
  'system:connection_monitor_saturated',
  'system:export_sealed',
  'system:http_body_pruned',
  'system:http_proxy_failed',
  'system:http_proxy_orphan_reclaimed',
  'system:http_proxy_started',
  'system:http_proxy_stopped',
  'system:ip_verdict',
  'system:logged_tier_digest',
  'system:opsec_airgap',
  'system:opsec_state_changed',
  'system:process_monitor_ps_unavailable',
  'system:process_monitor_saturated',
  'system:producer_heartbeat',
  'system:recording_paused',
  'system:recording_resumed',
  'system:retention_pruned_logged',
  'system:sanitized',
  'system:scope_cleared',
  'system:scope_recomputed',
  'system:scope_violation',
  'system:screenshot_deleted',
  'system:screenshot_evicted',
  'system:screenshot_pruned',
  'system:session_start',
  'system:update_completed',
  'system:update_not_applied',
  'system:update_pending'
]

describe('every kind opens in the reader that fits it (FR-030, US2)', () => {
  const defaults = EXAMPLES.filter((e) => e.id === e.kind)
  for (const e of defaults) {
    const run = (): void => {
      const today = eventReader(e.row)
      expect(TODAY[today], `${e.id}: eventReader says ${today}`).toBe(expectedReader(e.kind))
    }
    if (RED_READER.includes(e.id)) it.fails(`${e.id} → ${expectedReader(e.kind)}`, run)
    else it(`${e.id} → ${expectedReader(e.kind)}`, run)
  }

  it('lists no id that is not a default example', () => {
    expect(RED_READER.filter((id) => !defaults.some((e) => e.id === id))).toEqual([])
  })
})
