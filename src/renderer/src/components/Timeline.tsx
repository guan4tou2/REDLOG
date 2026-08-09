import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { maskEventData, fieldsWithRedactions, type RedactionSpan } from '../lib/mask'
import { LoadingSpinner } from './Feedback'
import { getLastVerifyResult, VERIFY_UPDATED_EVENT, type FullVerifyResult } from '../lib/verifyResultCache'

const MIN_LANE_H = 36
const LABEL_W = 92
const BASE_TRACK_W = 2000
// v0.6.92 W-project: added `browser` (CDP console) between scanner and dns,
// and `process` (spawn/exit) between scope and system so it doesn't dilute
// the top attack-narrative lanes.
const LANES = ['shell', 'agent', 'http_navigation', 'scanner', 'browser', 'dns', 'pivot', 'screenshot', 'clipboard', 'file_transfer', 'credential_use', 'c2_checkin', 'marker', 'loot', 'cleanup', 'scope', 'process', 'system'] as const
type LaneId = (typeof LANES)[number]

// Lanes with no built-in producer — populated only by external agents
// (custom MCP tools, third-party plugins) posting to /api/events. Showing
// them as plain "empty" is misleading; the chip tooltip says so explicitly.
// v0.6.92: `dns` now has a built-in producer (mitmproxy DNS mode), so it's
// removed from this set. `credential_use` and `c2_checkin` remain external-only.
const EXTERNAL_ONLY_LANES: Set<LaneId> = new Set(['credential_use', 'c2_checkin'])

const LANE_COLORS: Record<LaneId, string> = {
  shell: '#22c55e',
  agent: '#84cc16',
  http_navigation: '#6366f1',
  scanner: '#8b5cf6',
  browser: '#06b6d4',
  dns: '#14b8a6',
  pivot: '#0ea5e9',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  file_transfer: '#a78bfa',
  credential_use: '#eab308',
  c2_checkin: '#f43f5e',
  marker: '#ef4444',
  loot: '#f97316',
  cleanup: '#dc2626',
  scope: '#ef4444',
  process: '#f472b6',
  system: '#52525b'
}

// v0.6.87 C1: markers created by right-clicking Timeline background carry
// a `data.atTimestamp` that overrides their chain wall-clock for rendering
// purposes only. This keeps the chain honest (the row's `timestamp` still
// records when it was actually created) while letting the marker appear on
// the Timeline where the operator meant to drop it. Non-marker events
// always render at their true timestamp.
function displayTs(e: RedLogEvent): number {
  const at = e.data?.atTimestamp
  if (e.agentType === 'marker' && typeof at === 'number' && at > 0) return at
  return e.timestamp
}

/** v0.9.2 U1: pick the first string-valued arg from a tool_call input for
 *  the lane one-liner. Falls back to key list when the values are all
 *  objects/arrays. Cap prevents a giant path from dominating the row. */
function firstStringArg(input: Record<string, unknown>, cap: number): string {
  // Priority order matches the built-in tool-command picker in tailer-host
  // so what the row shows lines up with what the sensitive-path masking
  // sees ("Bash: rm -rf /" reads the same on both sides).
  for (const k of ['command', 'file_path', 'path', 'url', 'query', 'pattern']) {
    const v = input[k]
    if (typeof v === 'string' && v) {
      const s = v.replace(/\s+/g, ' ').trim()
      return s.length > cap ? s.slice(0, cap) + '…' : s
    }
  }
  const keys = Object.keys(input)
  return keys.length ? `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}` : ''
}

function eventTitle(event: RedLogEvent): string {
  const d = event.data
  switch (event.agentType) {
    case 'shell':
      if (d.subtype === 'command_start') return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'command_end') return `$ ${(d.command as string).slice(0, 80)} → exit ${d.exit_code}`
      if (d.subtype === 'command' && d.command) return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'session_start') return `▸ terminal opened`
      if (d.subtype === 'session_end') return `▪ terminal closed${d.exitCode != null ? ` (exit ${d.exitCode})` : ''}`
      return 'Shell event'
    case 'dns': {
      // v0.6.92 W-project: mitmproxy DNS mode fills query_name/query_type +
      // (on response) response_code + answers[]. Fall back to older
      // dest_host/command shape for events posted by legacy external agents.
      const qName = (d.query_name as string) || (d.dest_host as string) || (d.command as string) || ''
      const qType = (d.query_type as string) || ''
      if (d.subtype === 'dns_response') {
        const answers = (d.answers as Array<{ type?: string; data?: string }> | undefined) ?? []
        const preview = answers.length > 0
          ? ` → ${answers.slice(0, 2).map((a) => a.data ?? '').filter(Boolean).join(', ')}`
          : ''
        const dur = d.duration_ms != null ? ` (${d.duration_ms}ms)` : ''
        const rcode = d.response_code ? ` [${d.response_code}]` : ''
        return `DNS ⇐ ${qName} ${qType}${rcode}${preview}${dur}`.trim()
      }
      return `DNS ⇒ ${qName} ${qType}`.trim()
    }
    case 'browser': {
      // v0.6.92: CDP console + exception + log-entry events. Errors/exceptions
      // get a warning glyph; ordinary logs get an info glyph. Message is
      // capped at 80 chars for the lane label; full content lives in `data`.
      const level = String(d.level ?? 'log')
      const host = (d.host as string) || (d.url as string) || ''
      const msg = String(d.message ?? '').slice(0, 80).replace(/\s+/g, ' ')
      const glyph = level === 'error' || level === 'warning' || level === 'warn' || d.subtype === 'exception' ? '⚠' : '▸'
      if (d.subtype === 'exception') return `⚠ [exception] ${host}: ${(d.exception_class as string) || 'Error'} — ${msg}`.trim()
      return `${glyph} [${level}] ${host}: ${msg}`.trim()
    }
    case 'process': {
      // v0.6.92: ps-polling produced spawn/exit events. Command is capped at
      // 60 chars for the lane label; full argv lives on the event.
      const cmd = String(d.command ?? '').slice(0, 60)
      if (d.subtype === 'process_exit') {
        const dur = d.duration_sec != null ? ` (${d.duration_sec}s)` : ''
        return `▪ ${cmd}${dur}`.trim()
      }
      return `▶ ${cmd}`.trim()
    }
    case 'http_navigation':
      return `⇢ ${d.host || d.url || ''} ${d.title ? `— ${(d.title as string).slice(0, 60)}` : ''}`.trim()
    case 'scanner': {
      const method = (d.method as string) || ''
      const url = (d.url as string) || (d.host as string) || ''
      switch (d.subtype) {
        case 'http_request_start':
          return `[req] ${method} ${url}`.trim()
        case 'http_response':
          return `[${d.duration_ms ?? '?'} ms] ${method} ${url} → ${d.status ?? '?'}`.trim()
        case 'http_request_dropped': {
          const age = d.age_sec != null ? `${d.age_sec}s` : '?'
          return `[dropped after ${age}] ${method} ${url}`.trim()
        }
        case 'http_error':
          return `[err] ${method} ${url}: ${d.error || 'unknown'}`.trim()
        default:
          return `[${d.subtype || 'req'}] ${method} ${url}`.trim()
      }
    }
    case 'screenshot':
      return `Screenshot (${d.trigger})`
    case 'clipboard':
      return `Clipboard: ${(d.content as string)?.slice(0, 60) || ''}...`
    case 'file_transfer': {
      // v0.6.92 W-project: file-watcher emits subtype file_created/modified/
      // deleted + `path` + `size`. Shell hooks + external agents keep the
      // older filename/localPath/remotePath + bytes shape.
      const label = d.subtype || d.direction || 'transfer'
      const target = d.path || d.filename || d.localPath || d.remotePath || ''
      const size = d.size != null ? ` (${d.size}B)` : d.bytes ? ` (${d.bytes}B)` : ''
      return `${label}: ${target}${size}`.trim()
    }
    case 'credential_use':
      return `${d.subtype || 'cred'}: ${d.user_context || '?'} @ ${d.dest_host || d.dest_ip || ''}`
    case 'c2_checkin':
      return `C2 beacon ← ${d.dest_ip || d.dest_host || ''} ${d.bytes ? `(${d.bytes}B)` : ''}`.trim()
    case 'pivot':
      return `Pivot [${d.tool}] ${d.subtype || ''}${d.via ? ` → ${d.via}` : ''}${d.route ? ` (${d.route})` : ''}`.trim()
    case 'cleanup':
      return `⚠ Cleanup [${d.tool}] ${d.subtype || ''}${d.target ? ` → ${d.target}` : ''}`.trim()
    case 'marker':
      return `${(d.severity as string || 'info').toUpperCase()}: ${d.title}`
    case 'loot': {
      const m = (d.matches as Array<{ type: string; confidence: string }>)?.[0]
      return m ? `Loot: ${m.type.replace(/_/g, ' ')} (${m.confidence})` : `Loot: ${d.count ?? 0} detected`
    }
    case 'agent': {
      // v0.9.2 U1: operator-friendly one-line for AI-agent turns. Old default
      // fallback rendered "agent: user_message" with the payload text
      // effectively invisible unless the operator opened raw JSON. Now the
      // lane row shows a role glyph + the message body, truncated so long
      // turns stay compact; the detail panel (AgentTurnDetail) has the full
      // expand.
      const sub = String(d.subtype ?? '')
      // Prefer `preview` (already redaction-aware, capped at previewChars);
      // fall back to `full` for adapters that emit content but no preview
      // (external agents), then to `output` for tool_result.
      const raw = String(
        d.preview ?? d.full ?? d.output ?? d.textContent ?? ''
      ).replace(/\s+/g, ' ').trim()
      const cap = 100
      const body = raw.length > cap ? raw.slice(0, cap) + '…' : raw
      if (sub === 'user_message') return body ? `❯ user: ${body}` : `❯ user`
      if (sub === 'assistant_message') return body ? `◂ asst: ${body}` : `◂ asst`
      if (sub === 'tool_call') {
        const name = String(d.tool_name ?? 'tool')
        // For tool_call, tool_input isn't in `preview` — surface the tool
        // name + a compact hint (first string arg) instead of empty text.
        const input = d.tool_input as Record<string, unknown> | undefined
        const hint = input ? firstStringArg(input, 60) : ''
        return hint ? `⚙ ${name}: ${hint}` : `⚙ ${name}`
      }
      if (sub === 'tool_result') return body ? `↩ result: ${body}` : `↩ result`
      if (sub === 'thinking') return body ? `💭 ${body}` : `💭 thinking`
      if (sub === 'compact_summary') return `⇉ context compacted`
      if (sub === 'tool_interrupted') return body ? `⏹ interrupted: ${body}` : `⏹ tool interrupted`
      if (sub === 'away_summary') return body ? `⌛ away: ${body}` : `⌛ away summary`
      if (sub === 'transcript_snapshot') return `📸 snapshot (${d.turns_emitted ?? '?'} turns)`
      if (sub === 'session_end') return `▪ session ended (${d.turns_emitted ?? '?'} turns)`
      if (sub === 'transcript_compacted') return `⇉ transcript reset`
      if (sub === 'transcript_schema_drift') return `⚠ schema drift: ${d.unknown_type ?? '?'}`
      if (sub === 'transcript_parent_missing') return `⚠ parent-missing buffer full`
      return `agent: ${sub}`
    }
    case 'system':
      if (d.subtype === 'scope_violation') return `⚠ Scope violation: ${d.target || d.command || ''}`
      if (d.subtype === 'ip_transition') return `⇋ ${d.description || 'IP transition'}`
      if (d.subtype === 'opsec_state_changed') return `⇋ OPSEC: ${d.description || 'state changed'}`
      if (d.subtype === 'recording_paused') return `⏸ Recording paused`
      if (d.subtype === 'recording_resumed') return `⏺ Recording resumed`
      if (d.subtype === 'config_changed') return `⚙ ${d.description || 'Config changed'}`
      if (d.subtype === 'browser_launched') return `▸ Browser (${d.proxy ? `proxy ${d.proxy}` : 'no proxy'})`
      if (d.subtype === 'secret_revealed') return `👁 Secret revealed: ${(d.fields as string[])?.join(', ') || 'unknown fields'}`
      return `${event.agentType}: ${d.subtype || ''}`
    default:
      return `${event.agentType}: ${d.subtype || ''}`
  }
}

function toLane(agentType: string, subtype?: string, pluginTypes?: PluginEventType[]): LaneId {
  // Scope violations are stored under agent_type='system' for historical reasons
  // (the deconfliction webhook filter watches 'system'). Route them into their own
  // lane at render time so they don't drown in the system-lane housekeeping.
  if (agentType === 'system' && subtype === 'scope_violation') return 'scope'
  if (LANES.includes(agentType as LaneId)) return agentType as LaneId
  // Plugin-registered event type maps into whichever built-in lane the plugin
  // declared (its `lane` field). Falls back to `system` when the plugin didn't
  // supply one or the declared lane isn't valid.
  const pluginDef = pluginTypes?.find((p) => p.agentType === agentType)
  if (pluginDef?.lane && LANES.includes(pluginDef.lane as LaneId)) return pluginDef.lane as LaneId
  return 'system'
}

interface PluginEventType {
  agentType: string
  label: string
  lane?: string
  color?: string
  icon?: string
  pluginId: string
}

// Lifecycle noise kept in the DB for the record but hidden from the timeline so
// it doesn't drown the actual operation. Real user/agent actions still show; only
// the app's own plumbing is suppressed:
//   • system.api_started / session_start — RedLog boot, once per app open
//   • system.deconfliction_test — manual test button in Settings
//   • shell.session_start / session_end — user opened/closed a terminal pane
//   • terminal.session_start — duplicate write-path for the same pane-open event
//   • command_start whose command IS just sourcing the shell hook (the "silent"
//     hook install runs as a real preexec, so the hook itself logs it as a
//     command; that's plumbing, not a user command)
function isHookSource(cmd: unknown): boolean {
  return typeof cmd === 'string' && /shell-preexec-hook\.sh/.test(cmd)
}
function isHousekeeping(e: RedLogEvent): boolean {
  const s = e.data?.subtype as string | undefined
  if (e.agentType === 'system' && (s === 'api_started' || s === 'session_start' || s === 'deconfliction_test')) return true
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

// A shell command_start is only interesting on its own if no command_end ever
// arrives (still-running command). When the pair completes, the end has all the
// signal (exit code + duration), so hide the redundant start. Match on pid+cmd.
// Comparator: primary sort by wall-clock, tiebreak by monotonic_ns when
// two events share the same ms. monotonic_ns comes from Node's process.hrtime
// (or its equivalent) and is captured as a string of digits — compare as
// BigInt so we don't collapse 40-digit values into Number precision. This is
// the audit's P2 ordering fix: without it, two events that landed in the
// same millisecond had no defined order, so a cluster's popover items and
// the pagination anchor could disagree between page loads. Falls back to
// event id (uuid) for a stable final tiebreak.
function eventCompare(a: RedLogEvent, b: RedLogEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const am = a.monotonicNs, bm = b.monotonicNs
  if (am && bm && am !== bm) {
    try {
      const ai = BigInt(am), bi = BigInt(bm)
      return ai < bi ? -1 : ai > bi ? 1 : 0
    } catch { /* fall through to id */ }
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// v0.6.95 P1-12: keep the events array sorted incrementally rather than
// re-sorting on every batch. Full sort of 100k events is O(n log n) ~ 1.7M
// compares per flush — at 200 evt/s that's a heap-thrash. Since events almost
// always arrive in `created_at` order, the common case is "append to end",
// which we detect with a cheap last-element check and skip the search entirely.
// Only genuinely out-of-order rows (wall-clock regression, backfilled agents)
// need the O(log n) binary search + O(n) shift.
function binarySearchInsert(sorted: RedLogEvent[], evt: RedLogEvent): void {
  const n = sorted.length
  if (n === 0) { sorted.push(evt); return }
  if (eventCompare(evt, sorted[n - 1]) >= 0) { sorted.push(evt); return }
  // Bisect: find the leftmost index i where sorted[i] >= evt.
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (eventCompare(sorted[mid], evt) < 0) lo = mid + 1
    else hi = mid
  }
  sorted.splice(lo, 0, evt)
}

/** v0.9.3 U3: per-turn agent subtypes that get hidden when the operator
 *  toggles "collapse agent sessions". `transcript_snapshot` and
 *  `session_end` deliberately stay visible — they ARE the session-level
 *  view. Housekeeping (schema_drift / parent_missing / transcript_
 *  compacted) also stays visible since operators need to see anomalies. */
const COLLAPSIBLE_AGENT_SUBTYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'thinking',
  'compact_summary',
  'tool_interrupted',
  'away_summary'
])

function isCollapsibleAgentTurn(e: RedLogEvent): boolean {
  return e.agentType === 'agent'
    && COLLAPSIBLE_AGENT_SUBTYPES.has(String(e.data?.subtype ?? ''))
}

function filterAgentTurns(events: RedLogEvent[], collapse: boolean): RedLogEvent[] {
  if (!collapse) return events
  return events.filter((e) => !isCollapsibleAgentTurn(e))
}

function collapseCommandPairs(events: RedLogEvent[]): RedLogEvent[] {
  const closed = new Set<string>()
  for (const e of events) {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_end') continue
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    closed.add(key)
  }
  return events.filter((e) => {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_start') return true
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    return !closed.has(key)
  })
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// v0.6.91 S7: timezone-aware formatter. Every timestamp shown in the Timeline
// (axis ticks, cluster popovers, event list, detail panel) routes through
// this so the operator's chosen zone (Local / UTC / Project-configured) sticks.
// Invalid `projectTz` (typo, unrecognised IANA name) silently falls back to
// Local so the UI never breaks — the picker itself guards against bad names.
type TzMode = 'local' | 'utc' | 'project'
type TsStyle = 'time' | 'timeSec' | 'full'
function formatTs(ms: number, tz: TzMode, projectTz: string | null, style: TsStyle = 'time'): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (tz === 'utc') {
    // toISOString → 2026-01-01T15:04:05.123Z
    if (style === 'time') return d.toISOString().slice(11, 16) + 'Z'
    if (style === 'timeSec') return d.toISOString().slice(11, 19) + 'Z'
    return d.toISOString().replace('T', ' ')
  }
  const timeZone = tz === 'project' && projectTz ? projectTz : undefined
  const opts: Intl.DateTimeFormatOptions = {}
  if (timeZone) opts.timeZone = timeZone
  try {
    if (style === 'time') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...opts })
    if (style === 'timeSec') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', ...opts })
    return d.toLocaleString([], opts)
  } catch {
    // Bad IANA name → fall back to Local so a mistyped project.timezone can't
    // wipe every time label on the panel.
    if (style === 'time') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (style === 'timeSec') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return d.toLocaleString()
  }
}

// v0.6.91 W1/W3: simple case-insensitive substring "score". Higher = better.
// Earlier match position wins, then shorter-target-vs-query wins as tiebreak.
// Deliberately not a real fuzzy matcher (no gap tolerance) — the palette and
// filter both aim at literal identifiers (command names, hosts, subtypes) so
// the extra false-positive noise of a subsequence matcher isn't worth it.
function fuzzyScore(target: string, q: string): number {
  if (!q) return 0
  if (!target) return -1
  const idx = target.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return -1
  return 1000 - idx - Math.max(0, target.length - q.length) * 0.05
}

// Human-readable duration used by the follow-mode badge — "5s / 3m / 1h".
// Bounded at "24h+" so an operator staring at a stale panel doesn't see
// "8734h behind" which reads as broken UI.
function formatBehind(ms: number): string {
  if (ms < 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `24h+`
}

// v0.6.89.5: chain-integrity + evidence-integrity badges.
//
// A single event can carry several flags in `data` — clock-anomaly, orphan
// recovery, spool replay, evidence removal, anchor failure, background
// tampering. Rather than inventing per-badge CSS in every callsite the
// Timeline computes a `{icon, reason}` list once and renders a single icon
// on the dot (with all badges in a hover tooltip) + a full stacked row in
// the detail panel.
//
// The `⛓️‍💥` badge (feature 5) is only attached when a full-verify has been
// run AND this event id matches `brokenAtEventId` from that run.
interface EventBadge { icon: string; reason: string; key: string }

/** v0.9.6 (T3): what the track should say about a shell command's output.
 *  `fail` outlines the dot when the command exited non-zero; `io` decides
 *  the small notch on its lower-right. Deliberately two channels rather than
 *  more colour — the 18 lane hues already sit past what's reliably
 *  distinguishable, so this reads as texture on top of the lane colour. */
// `recorded` means a bracketed span of the session .cast belongs to this
// command — NOT that the command printed something. The span is measured in
// cast bytes (JSON-framed writes, including the shell's own echo of the
// command line), so even `true` brackets ~150 B. Distinguishing "printed
// nothing" from "printed something" would mean reading and ANSI-stripping the
// range, which is exactly the O(len)-per-command cost the byte offsets exist
// to avoid. So we claim only what an O(1) stamp can know.
type IoMark = 'recorded' | 'uncaptured' | null
function ioMark(e: RedLogEvent): { io: IoMark; fail: boolean } {
  if (e.agentType !== 'shell' || e.data?.subtype !== 'command_end') return { io: null, fail: false }
  const fail = Number(e.data?.exit_code ?? 0) !== 0
  // Inline streams (the `redlog-run` wrapper) win — the bytes are right there.
  const inline = typeof e.data?.stdout === 'string' || typeof e.data?.stderr === 'string' || typeof e.data?.output === 'string'
  if (inline) {
    // The wrapper streams ARE the output, so here the distinction is real.
    const n = String(e.data?.stdout ?? '').length + String(e.data?.stderr ?? '').length + String(e.data?.output ?? '').length
    return { io: n > 0 ? 'recorded' : null, fail }
  }
  const io = e.data?.io as { len?: number; unbracketed?: boolean } | undefined
  if (io && typeof io.len === 'number' && !io.unbracketed && io.len > 0) {
    return { io: 'recorded', fail }
  }
  // Nothing captured: an external shell without the wrapper, or a pair we
  // couldn't bracket. Not the same as "printed nothing" — say so.
  return { io: 'uncaptured', fail }
}

function ioTitle(m: { io: IoMark; fail: boolean }, t: (k: string) => string): string {
  const parts: string[] = []
  if (m.fail) parts.push(t('timeline.io.failed'))
  if (m.io === 'recorded') parts.push(t('timeline.io.recorded'))
  else if (m.io === 'uncaptured') parts.push(t('timeline.io.uncaptured'))
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

const IO_MARK_COLOR: Record<Exclude<IoMark, null>, string> = {
  recorded: '#e5e5e5',
  uncaptured: '#f59e0b'
}

function computeBadges(evt: RedLogEvent, brokenAtId?: string | null): EventBadge[] {
  const b: EventBadge[] = []
  const d = (evt.data as Record<string, unknown> | undefined) ?? {}
  const sub = d.subtype as string | undefined
  const clockAnomaly = d._clock_anomaly as { reason?: string } | undefined
  if (clockAnomaly) {
    b.push({ icon: '⚠', reason: clockAnomaly.reason || 'clock anomaly detected at insert time', key: 'clock' })
  }
  if (d.recovered === true) {
    b.push({ icon: '🔄', reason: 'recovered from orphaned session', key: 'recovered' })
  }
  if (d.recovered_from_spool === true) {
    b.push({ icon: '📮', reason: 'recovered from shell hook spool', key: 'spool' })
  }
  if (evt.agentType === 'system' && (sub === 'screenshot_deleted' || sub === 'cast_pruned' || sub === 'screenshot_pruned')) {
    b.push({ icon: '🗑️', reason: `evidence removed (${sub})`, key: 'evidence' })
  }
  if (evt.agentType === 'system' && sub === 'anchor_failed') {
    b.push({ icon: '⚓✗', reason: 'OTS anchor failed', key: 'anchor' })
  }
  if (evt.agentType === 'system' && sub === 'chain_sample_broken') {
    b.push({ icon: '⛓️‍💥', reason: 'background chain sampler detected tampering', key: 'sample-broken' })
  }
  if (brokenAtId && evt.id === brokenAtId) {
    b.push({ icon: '⛓️‍💥', reason: 'full-chain verify broke here', key: 'verify-broken' })
  }
  // v0.7.7 U2: subagent (Task tool) turn marker. The agent tailer stamps
  // `is_sidechain: true` on any transcript line whose original JSONL
  // record carried the `isSidechain` flag. Rendering an explicit ↪ badge
  // + Timeline indent (elsewhere) lets the operator tell "this was a
  // parallel Task subagent" apart from main-thread turns at a glance —
  // pre-v0.7.7 those events looked identical and buried the whole
  // subagent subtree.
  if (evt.agentType === 'agent' && d.is_sidechain === true) {
    b.push({ icon: '↪', reason: 'subagent (Task tool) turn — separate reasoning thread', key: 'sidechain' })
  }
  return b
}

/** v0.7.7 U2: horizontal indent for subagent turns on the Timeline.
 *  Non-zero when the event's `data.is_sidechain === true`. Returned in
 *  pixels so callers can add it directly to a `left` or `paddingLeft`
 *  style without a lookup table. */
export function subagentIndentPx(evt: RedLogEvent): number {
  const d = (evt.data as Record<string, unknown> | undefined) ?? {}
  return evt.agentType === 'agent' && d.is_sidechain === true ? 12 : 0
}

// BFS walk of the causal graph anchored at `anchor`. Walks `_causes` upstream
// AND the reverse-effects map downstream, both bounded to depth 20 to avoid
// runaway when a plugin publishes a cycle. Returns every id in the connected
// component including the anchor itself.
function walkFocusChain(
  anchor: RedLogEvent,
  eventsMap: Map<string, RedLogEvent>,
  effects: Map<string, string[]>
): Set<string> {
  const visited = new Set<string>([anchor.id])
  const q: { id: string; depth: number; dir: 'up' | 'down' }[] = [
    { id: anchor.id, depth: 0, dir: 'up' },
    { id: anchor.id, depth: 0, dir: 'down' }
  ]
  while (q.length) {
    const { id, depth, dir } = q.shift()!
    if (depth >= 20) continue
    if (dir === 'up') {
      const e = eventsMap.get(id)
      const causes = (e?.data as { _causes?: unknown } | undefined)?._causes
      if (Array.isArray(causes)) {
        for (const c of causes) {
          if (typeof c === 'string' && !visited.has(c)) {
            visited.add(c)
            q.push({ id: c, depth: depth + 1, dir: 'up' })
          }
        }
      }
    } else {
      const eff = effects.get(id)
      if (eff) for (const c of eff) {
        if (!visited.has(c)) {
          visited.add(c)
          q.push({ id: c, depth: depth + 1, dir: 'down' })
        }
      }
    }
  }
  return visited
}

export default function TimelinePanel({ focusEventId, focusTs, onDropMarker }: { focusEventId?: string; focusTs?: number; onDropMarker?: (ts: number) => void } = {}): JSX.Element {
  const [rawEvents, setEvents] = useState<RedLogEvent[]>([])
  // v0.9.3 U3: agent-session collapse toggle. When on, hide per-turn agent
  // subtypes (user_message / assistant_message / tool_call / tool_result /
  // thinking / compact_summary) — leaving transcript_snapshot + session_end
  // so a 500-turn Claude session shows as 2-4 dots instead of drowning the
  // agent lane. Per-project persisted; default off (existing operators
  // don't lose visibility on upgrade). Toggle chip in the header + `?`
  // cheatsheet lists it.
  const [collapseAgentTurns, setCollapseAgentTurns] = useState<boolean>(() => {
    try { return localStorage.getItem('redlog-timeline-collapse-agent') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-collapse-agent', collapseAgentTurns ? '1' : '0') } catch { /* ignore */ }
  }, [collapseAgentTurns])
  // Hide command_start once its matching command_end lands — the end has the
  // exit code + duration, so the start would just be a duplicate row.
  // v0.9.3: also drops per-turn agent events when the collapse toggle is on.
  const events = useMemo(
    () => filterAgentTurns(collapseCommandPairs(rawEvents), collapseAgentTurns),
    [rawEvents, collapseAgentTurns]
  )
  // Count of hidden agent turns to surface on the chip so the operator
  // knows the toggle is doing something (else the empty agent lane looks
  // like a bug). Recomputed only when raw events or toggle change.
  const hiddenAgentTurnCount = useMemo(() => {
    if (!collapseAgentTurns) return 0
    return rawEvents.filter(isCollapsibleAgentTurn).length
  }, [rawEvents, collapseAgentTurns])
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const [allLoaded, setAllLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [containerH, setContainerH] = useState(0)
  // v0.6.91 S4: persisted zoom. Clamped to the same [0.25, 6] range the ± buttons
  // enforce so a garbage value in storage can't produce a broken layout.
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-zoom')
      const n = raw ? parseFloat(raw) : NaN
      return Number.isFinite(n) && n >= 0.25 && n <= 6 ? n : 1
    } catch { return 1 }
  })
  const [cluster, setCluster] = useState<{ x: number; y: number; events: RedLogEvent[] } | null>(null)
  const [view, setView] = useState({ left: 0, width: 100 })
  const [drag, setDrag] = useState<{ x0: number; x1: number; w: number } | null>(null)
  const pendingView = useRef<{ t0: number } | null>(null)
  // Cluster-item click needs a two-frame handshake: bump zoom so the events
  // split into distinct dots, then center on the picked one after re-render.
  // We can't scroll synchronously because TRACK_W hasn't grown yet.
  const pendingCenterTs = useRef<number | null>(null)
  // v0.6.91 S4: hidden-lane visibility now persists across mounts so an
  // operator who solo'd "shell" doesn't lose that filter after a reload.
  // Stored as a JSON array of lane ids; unknown ids (renamed lanes from an
  // old release) are dropped silently.
  const [hiddenLanes, setHiddenLanes] = useState<Set<LaneId>>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-hidden-lanes')
      if (!raw) return new Set()
      const arr = JSON.parse(raw)
      return new Set((Array.isArray(arr) ? arr : []).filter((l): l is LaneId => LANES.includes(l as LaneId)))
    } catch { return new Set() }
  })
  const [showJson, setShowJson] = useState(false)
  // v0.9.3 U2: keyboard-shortcut cheatsheet modal. Every hotkey RedLog has
  // added since v0.6.90 was previously invisible unless a teammate told you.
  // `?` opens; Escape or click-outside closes.
  const [showHelp, setShowHelp] = useState(false)
  // Layer 3 (four-layer redaction): raw text of an event's redacted spans is
  // hidden by default in the detail view. The reviewer opts into a per-event
  // reveal; each reveal appends a chained system.secret_revealed event so the
  // audit trail shows raw bytes were viewed.
  const [revealedEvents, setRevealedEvents] = useState<Set<string>>(new Set())
  // Detail-panel height, in px. Persisted to localStorage so operator's chosen
  // size survives reloads. Default `null` = use CSS max-h-[45vh] fallback.
  const [detailPanelPx, setDetailPanelPx] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-detail-h')
      const n = raw ? parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n > 80 && n < 2000 ? n : null
    } catch { return null }
  })
  const detailResizing = useRef<{ startY: number; startH: number } | null>(null)
  // Detail panel container. Reset scroll to top on every selectedEvent change
  // so a cluster-popover click always lands you on the new item's title —
  // otherwise the panel keeps whatever scroll offset the prior event left
  // (with JSON expanded the title easily scrolls off screen).
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({})
  // v0.6.89.5: focus chain / anomaly filter / broken-chain state.
  //
  // `focusChain` (feature 2) is a set of every event id in the causal
  // component of the anchor — null means the filter is off. Persisted as
  // just the anchor id so a stale set can't leak across mounts.
  // `anomalyFilter` (feature 4) toggles "dim everything without a badge".
  // These two are mutually exclusive — enabling one clears the other.
  // `verifyResult` (feature 5) is the last full-chain-verify outcome; read
  // from the module cache on mount and refreshed via a window event.
  const [focusChain, setFocusChain] = useState<Set<string> | null>(null)
  const [focusAnchorId, setFocusAnchorId] = useState<string | null>(() => {
    try { return localStorage.getItem('redlog-timeline-focus-anchor') } catch { return null }
  })
  // v0.6.98 E: per-project anomaly filter. Pre-v0.6.98 the localStorage key
  // was global — flipping the filter on in Project A followed you into
  // Project B, which made triage confusing (why is my clean project showing
  // half its events dimmed?). Fix: append `:${projectId}` once known, with
  // one-shot migration from the legacy unscoped key on first mount per
  // project. Initial state uses the unscoped key for pre-v0.6.98 continuity
  // — it settles into the project-scoped value on the second render tick,
  // after project.active() resolves.
  //
  // v0.6.100 F5: `projectIdForKeys` also holds the sentinel `__global__` when
  // `project.active()` resolves null (no active project — first-launch, DMG
  // demo, tests). Pre-v0.6.100 that state silently dropped every scoped
  // write. Sentinel means the user's toggles still persist; they just live
  // under a common key until a project is opened.
  // v0.6.100 F6: `migrationAppliedFor` records the projectId (or sentinel)
  // we've already migrated for so a mid-triage user edit — filter-query
  // typing, focus toggle — doesn't get clobbered when project.active()
  // arrives seconds later. Migration only runs once per (project, mount).
  const [projectIdForKeys, setProjectIdForKeys] = useState<string | null>(null)
  const migrationAppliedFor = useRef<string | null>(null)
  const [anomalyFilter, setAnomalyFilter] = useState<boolean>(() => {
    try { return localStorage.getItem('redlog-timeline-anomaly-filter') === '1' } catch { return false }
  })
  useEffect(() => {
    // v0.6.100 F5: fall back to `__global__` sentinel when there's no active
    // project (or the call rejects). Anything downstream that reads
    // `projectIdForKeys` gets a stable key rather than a persistent-write
    // dead zone.
    window.redlog.project.active()
      .then((p) => setProjectIdForKeys(p?.id ?? '__global__'))
      .catch(() => setProjectIdForKeys('__global__'))
  }, [])
  useEffect(() => {
    // v0.6.98 E + v0.6.99 A: reload / migrate every per-project key once the
    // project id lands. Keys covered here are project-scoped (event ids,
    // in-progress filter text, lane visibility for this engagement). Keys
    // that stay global — zoom, detail-h, follow-mode, session-dividers, tz
    // — are UI/display preferences that shouldn't reset when opening a
    // different project. Each key migrates from its legacy unscoped form
    // ONCE per project so operators upgrading from < v0.6.98 don't lose
    // whatever they had set on the project they open first.
    // v0.6.100 F6: skip if we've already migrated for this project — the
    // ref guards against clobbering in-flight user edits. Without this,
    // typing into the filter-query box between mount and project.active()
    // resolution would be overwritten with the legacy value when this
    // effect fires.
    if (!projectIdForKeys) return
    if (migrationAppliedFor.current === projectIdForKeys) return
    migrationAppliedFor.current = projectIdForKeys
    const migrate = <T,>(base: string, decode: (s: string) => T, apply: (v: T) => void): void => {
      try {
        const scoped = `${base}:${projectIdForKeys}`
        const stored = localStorage.getItem(scoped)
        if (stored !== null) {
          apply(decode(stored))
        } else {
          const legacy = localStorage.getItem(base)
          if (legacy !== null) {
            localStorage.setItem(scoped, legacy)
            apply(decode(legacy))
          }
        }
      } catch { /* ignore */ }
    }
    migrate('redlog-timeline-anomaly-filter', (s) => s === '1', setAnomalyFilter)
    migrate('redlog-timeline-focus-anchor', (s) => s, setFocusAnchorId)
    migrate('redlog-timeline-filter-query', (s) => s, setFilterQuery)
    migrate('redlog-timeline-hidden-lanes', (s) => {
      try {
        const arr = JSON.parse(s)
        return new Set((Array.isArray(arr) ? arr : []).filter((l): l is LaneId => LANES.includes(l as LaneId)))
      } catch { return new Set<LaneId>() }
    }, setHiddenLanes)
  }, [projectIdForKeys])
  const [verifyResult, setVerifyResult] = useState<FullVerifyResult | null>(() => getLastVerifyResult())
  const [verifyDismissed, setVerifyDismissed] = useState(false)
  useEffect(() => {
    const onUpdate = (): void => {
      setVerifyResult(getLastVerifyResult())
      setVerifyDismissed(false)
    }
    window.addEventListener(VERIFY_UPDATED_EVENT, onUpdate)
    return () => window.removeEventListener(VERIFY_UPDATED_EVENT, onUpdate)
  }, [])
  useEffect(() => {
    // v0.6.99 A: scoped write once projectId is known. Legacy key untouched
    // so the migration path continues to find it on other project opens.
    if (!projectIdForKeys) return
    try {
      const scoped = `redlog-timeline-focus-anchor:${projectIdForKeys}`
      if (focusAnchorId) localStorage.setItem(scoped, focusAnchorId)
      else localStorage.removeItem(scoped)
    } catch { /* ignore */ }
  }, [focusAnchorId, projectIdForKeys])
  useEffect(() => {
    // v0.6.98 E: hold writes until projectId lands, then write only to the
    // scoped key. The legacy global key is left alone so the migration
    // path above still finds it on other project opens.
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-anomaly-filter:${projectIdForKeys}`, anomalyFilter ? '1' : '0')
    } catch { /* ignore */ }
  }, [anomalyFilter, projectIdForKeys])

  // v0.6.91 W1: inline `/` search — dims events whose title / command / URL /
  // host / operator doesn't substring-match the query. Persisted so the
  // filter survives a reload; empty string means "no filter".
  const [filterQuery, setFilterQuery] = useState<string>(() => {
    try { return localStorage.getItem('redlog-timeline-filter-query') || '' } catch { return '' }
  })
  useEffect(() => {
    // v0.6.99 A: scoped write. Legacy key untouched (migration on next open).
    if (!projectIdForKeys) return
    try {
      const scoped = `redlog-timeline-filter-query:${projectIdForKeys}`
      if (filterQuery) localStorage.setItem(scoped, filterQuery)
      else localStorage.removeItem(scoped)
    } catch { /* ignore */ }
  }, [filterQuery, projectIdForKeys])
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // v0.6.91 W2: follow mode — auto-scrolls the track's right edge to keep the
  // newest event visible while enabled. On by default; the header badge
  // reflects "🔴 LIVE" vs "⏸ Xm behind" state. `now` state ticks every second
  // just so the "behind" label refreshes without waiting for a new event.
  const [followMode, setFollowMode] = useState<boolean>(() => {
    try { return localStorage.getItem('redlog-timeline-follow-mode') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-follow-mode', followMode ? '1' : '0') } catch { /* ignore */ }
  }, [followMode])
  const [atRightEdge, setAtRightEdge] = useState(true)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // v0.6.91 S3: dashed vertical dividers + faint bands for shell.session_end
  // and system.recording_paused/resumed pairs. Toggle persisted; default on
  // because it's the primary visual anchor when reviewing a multi-terminal
  // engagement.
  const [sessionDividers, setSessionDividers] = useState<boolean>(() => {
    try { return localStorage.getItem('redlog-timeline-session-dividers') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-session-dividers', sessionDividers ? '1' : '0') } catch { /* ignore */ }
  }, [sessionDividers])

  // v0.6.91 S7: timezone picker. `projectTz` is filled from
  // config.engagement.timezone when the panel mounts; if unset or invalid,
  // the "Project" option falls back to Local (via formatTs).
  const [tz, setTz] = useState<TzMode>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-tz')
      return raw === 'utc' || raw === 'project' ? raw : 'local'
    } catch { return 'local' }
  })
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-tz', tz) } catch { /* ignore */ }
  }, [tz])
  const [projectTz, setProjectTz] = useState<string | null>(null)
  useEffect(() => {
    window.redlog.config?.get?.().then((c) => {
      const cfg = c as { engagement?: { timezone?: string } } | null | undefined
      const tzName = cfg?.engagement?.timezone
      setProjectTz(typeof tzName === 'string' && tzName ? tzName : null)
    }).catch(() => {})
  }, [])

  // v0.6.91 W3: ⌘K fuzzy palette. Opened by the App-level ⌘K when Timeline is
  // the active view, or by dispatching the `redlog-timeline-palette` event.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const paletteInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const onOpen = (): void => { setPaletteOpen(true); setPaletteQuery(''); setPaletteIndex(0) }
    window.addEventListener('redlog-timeline-palette', onOpen)
    return () => window.removeEventListener('redlog-timeline-palette', onOpen)
  }, [])
  useEffect(() => {
    if (paletteOpen) {
      // Autofocus after paint — the modal renders inside a portal-like fixed
      // overlay, and querying the ref sync in the same tick sometimes misses.
      requestAnimationFrame(() => paletteInputRef.current?.focus())
    }
  }, [paletteOpen])

  // v0.6.91 S1: saved views — list + save + delete. Loaded lazily when the
  // dropdown opens the first time; kept fresh across saves/deletes. `views`
  // API is optional in the preload contract so a stale renderer bundle
  // doesn't crash the panel — the dropdown just stays disabled.
  const [savedViews, setSavedViews] = useState<SavedTimelineView[] | null>(null)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [viewsName, setViewsName] = useState('')
  // v0.6.96 Clean-3: `views` is now non-optional in env.d.ts (preload always
  // exports it). The old cast is gone; direct access is type-safe.
  const viewsApi = window.redlog.views
  const refreshViews = useCallback(async (): Promise<void> => {
    if (!viewsApi?.list) return
    try { setSavedViews((await viewsApi.list()) ?? []) } catch { setSavedViews([]) }
  }, [viewsApi])
  useEffect(() => {
    if (viewsOpen && savedViews === null) void refreshViews()
  }, [viewsOpen, savedViews, refreshViews])

  // v0.6.91 W1 mutual exclusion: enabling any of the three dim modes clears
  // the others. Kept as a set of effects so keyboard, click, and event-listener
  // paths all converge. `focusChain` mutual exclusion with `anomalyFilter`
  // was already handled below — extending with filterQuery here.
  useEffect(() => {
    if (!filterQuery) return
    if (focusAnchorId) setFocusAnchorId(null)
    if (anomalyFilter) setAnomalyFilter(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery])

  // Plugin-registered event types (agent_type → lane/color/label mapping).
  // Previously event-registry.ts was a dead facade — plugin events were all
  // bucketed into `system`. Timeline now queries `plugins.eventTypes()` on
  // mount so a plugin advertising `{ agentType: 'burp', lane: 'scanner' }`
  // will render its rows in the scanner lane with the plugin's colour.
  const [pluginTypes, setPluginTypes] = useState<PluginEventType[]>([])
  useEffect(() => {
    try {
      const p = window.redlog.plugins?.eventTypes?.()
      if (p && typeof (p as Promise<unknown>).then === 'function') {
        (p as Promise<PluginEventType[]>).then((types) => setPluginTypes(types ?? [])).catch(() => {})
      }
    } catch { /* older preload */ }
  }, [])

  // On new selection: snap the detail panel back to the top, collapse the JSON
  // dump, and RE-MASK any previously-revealed events (audit finding #1).
  // Reveal was sticky per-session — leaving and coming back kept everything
  // unmasked, which weakens the mask-by-default contract. Now reveal only
  // applies to the actively-focused event.
  useEffect(() => {
    setShowJson(false)
    setRevealedEvents(new Set())
    if (detailPanelRef.current) detailPanelRef.current.scrollTop = 0
  }, [selectedEvent?.id])

  // Detail-panel drag-to-resize. Handle at the top edge of the panel — drag
  // up to grow, drag down to shrink. Persisted to localStorage so the choice
  // survives across reloads.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const s = detailResizing.current
      if (!s) return
      const dy = s.startY - e.clientY
      const next = Math.max(80, Math.min(window.innerHeight * 0.85, s.startH + dy))
      setDetailPanelPx(next)
    }
    const onUp = (): void => {
      if (!detailResizing.current) return
      detailResizing.current = null
      document.body.classList.remove('timeline-resizing')
      try { if (detailPanelPx != null) localStorage.setItem('redlog-timeline-detail-h', String(Math.round(detailPanelPx))) } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [detailPanelPx])

  useEffect(() => {
    const load = (): void => {
      window.redlog.operators.list().then((ops) => {
        const map: Record<string, string> = {}
        ops.forEach((op) => { map[op.id] = op.name })
        setOperatorNames(map)
      }).catch(() => {})
    }
    load()
    const unsub = window.redlog.events.onNew((e) => {
      if (e.operatorId && !operatorNames[e.operatorId]) load()
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const operatorLabel = (id: string): string => operatorNames[id] || id
  // With a single operator the column is the same string on every row — only
  // worth the horizontal space once a second identity shows up.
  const showOperator = Object.keys(operatorNames).length > 1
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())
  // v0.6.95 P1-12: sorted-by-eventCompare array kept in lockstep with the map.
  // Full re-sort of 100k events per flush was 1.7M comparisons; sorted-insert
  // makes an in-order arrival O(1) (push-to-end) and a genuine out-of-order
  // insert O(log n) find + O(n) shift. Kept as a ref (not state) because the
  // memoized `events` still comes from setEvents — sortedRef is just the
  // storage backing that setEvents call.
  const sortedRef = useRef<RedLogEvent[]>([])
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, scroll: 0 })
  const didScrollToNow = useRef(false)
  const pendingZoomAnchor = useRef<{ frac: number; cursorX: number } | null>(null)
  const { t } = useI18n()

  const laneLabels: Record<LaneId, string> = useMemo(() => ({
    shell: t('timeline.shell'),
    agent: t('timeline.agent'),
    http_navigation: t('timeline.http'),
    scanner: t('timeline.scanner'),
    browser: t('timeline.browser'),
    dns: t('timeline.dns'),
    pivot: t('timeline.pivot'),
    screenshot: t('timeline.screenshot'),
    clipboard: t('timeline.clipboard'),
    file_transfer: t('timeline.files'),
    credential_use: t('timeline.credentialUse'),
    c2_checkin: t('timeline.c2Checkin'),
    marker: t('timeline.markers'),
    loot: t('timeline.loot'),
    cleanup: t('timeline.cleanup'),
    scope: t('timeline.scope'),
    process: t('timeline.process'),
    system: t('timeline.system')
  }), [t])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => setContainerH(entry.contentRect.height))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // A lane with no events is dead vertical space — most engagements only ever
  // touch three or four of them. Keep the filter chip so the operator can see
  // the lane exists, but don't give it a row until something lands in it.
  const populatedLanes = useMemo(() => {
    const seen = new Set<LaneId>()
    for (const e of events) seen.add(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes))
    return seen
    // v0.6.95 P1-12: pluginTypes was missing from deps — a plugin-registered
    // event lane wouldn't appear on the filter chip until an unrelated state
    // change re-ran the memo. Same fix applied to `laneEvents` and
    // `recentEvents` below.
  }, [events, pluginTypes])

  const visibleLanes = useMemo(
    () => LANES.filter((l) => populatedLanes.has(l) && !hiddenLanes.has(l)),
    [populatedLanes, hiddenLanes]
  )

  const laneH = useMemo(() => {
    if (visibleLanes.length === 0) return MIN_LANE_H
    const axisH = 28
    const available = containerH - axisH
    return Math.max(MIN_LANE_H, Math.floor(available / visibleLanes.length))
  }, [containerH, visibleLanes.length])

  const loadMore = useCallback(() => {
    if (loading || allLoaded) return
    setLoading(true)
    // Pagination anchor: the oldest event we already have. Prefer `createdAt`
    // (SQL row insertion order — monotonically increasing under a running
    // process) over `timestamp` (wall-clock — can regress on NTP correction).
    //
    // v0.6.87 audit A1: if wall-clock jumped back mid-session, a new event
    // could have a `timestamp` older than one already in the map. Old code
    // used min(timestamp) as anchor and would happily skip that new event
    // because its timestamp fell inside the "already fetched" window — the
    // event was in the DB but pager pretended it had already been returned.
    // Anchoring on `createdAt` (which never regresses in practice — Date.now
    // for the write instant, but callers can't rewind DB row insertion) means
    // the pager walks strictly older rows even under wall-clock backwards.
    // v0.6.95 P1-12: sortedRef is the ground truth for ordering; scan it (or
    // the map — either works, but the sorted view lets us short-circuit at
    // the first element instead of walking every row).
    const sorted = sortedRef.current
    const before = sorted.length > 0 ? sorted[0].createdAt : undefined
    window.redlog.events.query({ limit: 200, beforeCreatedAt: before, excludeHousekeeping: true }).then((fetched) => {
      const newOnes = fetched.filter((e) => !eventsMapRef.current.has(e.id) && !isHousekeeping(e))
      if (fetched.length < 200) setAllLoaded(true)
      if (newOnes.length > 0) {
        for (const e of newOnes) {
          eventsMapRef.current.set(e.id, e)
          binarySearchInsert(sortedRef.current, e)
        }
        setEvents([...sortedRef.current])
      }
      setLoading(false)
    })
  }, [loading, allLoaded])

  useEffect(() => {
    window.redlog.events.query({ limit: 200, excludeHousekeeping: true }).then((fetched) => {
      if (fetched.length < 200) setAllLoaded(true)
      // v0.6.95 P1-12: seed the sortedRef from the initial fetch. If any live
      // events landed via the batch listener BEFORE the fetch resolved, they
      // are already in `eventsMapRef` — dedupe against that map so we don't
      // reset the sorted array to a stale snapshot missing the live rows.
      // Still worth one full sort because the DB returns rows in DESC order
      // and we want ASC internally; after this, every incoming update goes
      // through the sorted-insert path.
      const clean = fetched.filter((e) => !isHousekeeping(e))
      for (const e of clean) {
        if (!eventsMapRef.current.has(e.id)) eventsMapRef.current.set(e.id, e)
      }
      sortedRef.current = Array.from(eventsMapRef.current.values()).sort(eventCompare)
      setEvents([...sortedRef.current])
      setLoading(false)
    })
    // v0.6.95 P0-4c + P1-12: batch listener + sorted-insert. Main sends
    // `events:new-batch` with an Array<RedLogEvent> once per frame per burst;
    // this handler folds them into the sorted array in one shot, then does a
    // single setEvents / re-render. Falls back to `onNew` per-event only if
    // the batch channel isn't wired (older preload — shouldn't happen).
    let scheduled = false
    const flush = (): void => {
      scheduled = false
      // Shallow copy so React sees a new reference and re-renders.
      setEvents([...sortedRef.current])
    }
    const ingest = (event: RedLogEvent): void => {
      if (isHousekeeping(event)) return
      if (eventsMapRef.current.has(event.id)) {
        // Same id arriving again is either a duplicate broadcast (both channels
        // fire) or an updated payload. Overwrite the map entry but leave the
        // sorted array position alone — id-based sort tiebreak keeps it stable.
        eventsMapRef.current.set(event.id, event)
        return
      }
      eventsMapRef.current.set(event.id, event)
      binarySearchInsert(sortedRef.current, event)
    }
    const scheduleFlush = (): void => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(flush)
    }
    const unsubBatch = window.redlog.events.onNewBatch
      ? window.redlog.events.onNewBatch((events) => {
          if (!events?.length) return
          for (const e of events) ingest(e)
          scheduleFlush()
        })
      : null
    // Keep the per-event subscriber ONLY when the batch channel is missing —
    // otherwise both channels fire for every event and each row is ingested
    // twice (second call is a no-op on the sorted array thanks to the map
    // check, but still wasted work).
    const unsubSingle = unsubBatch
      ? null
      : window.redlog.events.onNew((event) => { ingest(event); scheduleFlush() })
    return () => {
      unsubBatch?.()
      unsubSingle?.()
    }
  }, [])

  const { timeStart, timeEnd, ticks } = useMemo(() => {
    if (events.length === 0) {
      const now = Date.now()
      return { timeStart: now - 3600000, timeEnd: now, ticks: [] as number[] }
    }
    // v0.9.4 P0-3: the domain comes from `displayTs`, not `timestamp`.
    // `events` is sorted by wall-clock, but a marker carrying an
    // `atTimestamp` override renders somewhere else entirely — and when the
    // operator dropped one outside the current event range (right-click on
    // the padded edge of the track), first/last bounds pushed its `toX()`
    // below 0 or past TRACK_W and the dot silently vanished. One O(n) scan,
    // same order as the `bins` / `laneEvents` memos that already re-run on
    // every event change.
    let first = displayTs(events[0])
    let last = first
    for (const e of events) {
      const d = displayTs(e)
      if (d < first) first = d
      if (d > last) last = d
    }
    const pad = Math.max((last - first) * 0.05, 60000)
    const s = first - pad
    const e = last + pad
    const span = e - s
    const steps = Math.min(Math.max(Math.floor(span / 300000), 4), 20)
    const step = span / steps
    const ts: number[] = []
    for (let i = 0; i <= steps; i++) ts.push(s + i * step)
    return { timeStart: s, timeEnd: e, ticks: ts }
  }, [events])

  const TRACK_W = Math.round(BASE_TRACK_W * zoom)
  const timeSpan = timeEnd - timeStart
  const toX = useCallback((ts: number) => ((ts - timeStart) / timeSpan) * TRACK_W, [timeStart, timeSpan, TRACK_W])
  const totalH = visibleLanes.length * laneH

  const laneEvents = useMemo(() => {
    const map = Object.fromEntries(LANES.map((l) => [l, [] as RedLogEvent[]])) as Record<LaneId, RedLogEvent[]>
    for (const e of events) map[toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)].push(e)
    return map
  }, [events, pluginTypes])

  // v0.6.89.5: reverse-effects index (feature 1) — `effectsById[causeId] =
  // [effectEventId, ...]`. Built once per events change; O(N × avg-causes).
  // Also the badges index (feature 3) so every dot render is O(1). The
  // broken-at id from the last full verify (feature 5) participates in the
  // badge set so the `⛓️‍💥` badge lights up on the offending row.
  // v0.6.91 W1: filter-match set for the `/` search. Case-insensitive substring
  // over any of: data.command / data.url / data.host / data.title / data.subtype,
  // eventTitle (which is what the operator actually sees), and operatorId.
  // Rebuilt on every events / query change — cheap for <= 5k events; for larger
  // sets the outer dim path already dominates so this doesn't move the needle.
  const filterMatches = useMemo(() => {
    if (!filterQuery.trim()) return null
    const q = filterQuery.trim().toLowerCase()
    const set = new Set<string>()
    for (const e of events) {
      const d = e.data as Record<string, unknown> | undefined
      const bag = [
        String(d?.command ?? ''),
        String(d?.url ?? ''),
        String(d?.host ?? ''),
        String(d?.title ?? ''),
        String(d?.subtype ?? ''),
        e.agentType === 'marker' ? String(d?.title ?? '') : '',
        e.operatorId,
        operatorNames[e.operatorId] ?? '',
        eventTitle(e)
      ].join('').toLowerCase()
      if (bag.includes(q)) set.add(e.id)
    }
    return set
  }, [events, filterQuery, operatorNames])

  const brokenAtId = verifyDismissed ? null : (verifyResult?.brokenAtEventId ?? null)
  const effectsById = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of events) {
      const causes = (e.data as { _causes?: unknown } | undefined)?._causes
      if (Array.isArray(causes)) {
        for (const c of causes) {
          if (typeof c !== 'string') continue
          const arr = m.get(c)
          if (arr) arr.push(e.id)
          else m.set(c, [e.id])
        }
      }
    }
    return m
  }, [events])
  const badgesById = useMemo(() => {
    const m = new Map<string, EventBadge[]>()
    for (const e of events) {
      const b = computeBadges(e, brokenAtId)
      if (b.length) m.set(e.id, b)
    }
    return m
  }, [events, brokenAtId])
  const anomalyCount = badgesById.size

  // Restore-from-storage: if a focus anchor id was saved in a previous session
  // and it still exists in the current map, compute its chain. Runs whenever
  // the anchor id changes OR the reverse-effects index changes (i.e. new
  // events arrived that could extend the chain).
  useEffect(() => {
    if (!focusAnchorId) { setFocusChain(null); return }
    const anchor = eventsMapRef.current.get(focusAnchorId)
    if (!anchor) { setFocusChain(null); return }
    setFocusChain(walkFocusChain(anchor, eventsMapRef.current, effectsById))
  }, [focusAnchorId, effectsById])

  // Mutual exclusion: enabling focus chain implicitly turns anomaly filter off,
  // and vice versa. Done here (rather than at each toggle site) so keyboard
  // shortcuts and clicks stay in sync. Extended in v0.6.91 W1: enabling either
  // also clears the `/` filter query, since three overlapping dim modes are
  // impossible to reason about.
  useEffect(() => {
    if (!focusChain) return
    if (anomalyFilter) setAnomalyFilter(false)
    if (filterQuery) setFilterQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusChain])
  useEffect(() => {
    if (!anomalyFilter) return
    if (focusAnchorId) setFocusAnchorId(null)
    if (filterQuery) setFilterQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anomalyFilter])

  // v0.6.91 S4: persist zoom, hidden lanes, and selected-event id so a
  // Timeline reload lands the operator back where they were.
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-zoom', String(zoom)) } catch { /* ignore */ }
  }, [zoom])
  useEffect(() => {
    // v0.6.99 A: hidden-lanes is per-project. An operator who solo'd "shell"
    // for triage on Project A shouldn't carry that into Project B's fresh
    // open. Zoom right below stays global — it's a UI density preference,
    // not project state.
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-hidden-lanes:${projectIdForKeys}`, JSON.stringify([...hiddenLanes]))
    } catch { /* ignore */ }
  }, [hiddenLanes, projectIdForKeys])
  useEffect(() => {
    try {
      if (selectedEvent?.id) localStorage.setItem('redlog-timeline-focus-event', selectedEvent.id)
      else localStorage.removeItem('redlog-timeline-focus-event')
    } catch { /* ignore */ }
  }, [selectedEvent])
  // On first successful load, if no explicit prop-driven focus is in play,
  // restore the previously-selected event by id. Bail after one attempt so we
  // don't fight the operator's later clicks.
  const initialFocusRestoreRef = useRef(false)
  useEffect(() => {
    if (initialFocusRestoreRef.current) return
    if (loading || events.length === 0) return
    initialFocusRestoreRef.current = true
    if (focusEventId || focusTs || selectedEvent) return
    try {
      const id = localStorage.getItem('redlog-timeline-focus-event')
      if (!id) return
      const evt = eventsMapRef.current.get(id)
      if (evt) setSelectedEvent(evt)
    } catch { /* ignore */ }
  }, [loading, events, focusEventId, focusTs, selectedEvent])

  // Collapse events that fall within ~14px of each other on the same lane into a
  // single clickable marker (with a count) so dense bursts stay legible. Zooming
  // in widens the track, so clusters naturally split apart into individual dots.
  const CLUSTER_PX = 14
  const clusters = useMemo(() => {
    const out: Array<{ key: string; lane: LaneId; li: number; x: number; y: number; events: RedLogEvent[] }> = []
    visibleLanes.forEach((lane, li) => {
      const evs = laneEvents[lane]
      if (!evs.length) return
      let bucket: RedLogEvent[] = []
      let curBi = NaN
      const flush = (): void => {
        if (!bucket.length) return
        const x = bucket.reduce((a, e) => a + toX(displayTs(e)), 0) / bucket.length
        out.push({ key: `${lane}-${bucket[0].id}`, lane, li, x, y: li * laneH + laneH / 2, events: bucket })
        bucket = []
      }
      for (const e of evs) {
        const bi = Math.floor(toX(displayTs(e)) / CLUSTER_PX)
        if (bucket.length && bi !== curBi) flush()
        curBi = bi
        bucket.push(e)
      }
      flush()
    })
    return out
  }, [visibleLanes, laneEvents, toX, laneH])

  // v0.6.91 S3: derive session-band segments from `shell.session_end` +
  // `system.recording_paused`/`recording_resumed` pairs. session_start is
  // filtered by isHousekeeping so we use session_end.data.durationMs to
  // reconstruct the pair's window. Trailing paused-without-resume gets drawn
  // to the current time; trailing session-end without a duration is skipped
  // (nothing sensible to draw).
  type SessionBand = { id: string; x0: number; x1: number; label: string; kind: 'term' | 'paused' }
  const sessionBands = useMemo<SessionBand[]>(() => {
    if (!sessionDividers) return []
    const bands: SessionBand[] = []
    for (const e of events) {
      if (e.agentType === 'shell' && e.data?.subtype === 'session_end') {
        const tid = (e.data?.terminalId as string | undefined) ?? ''
        const durMs = Number(e.data?.durationMs)
        const endTs = e.timestamp
        const startTs = Number.isFinite(durMs) && durMs > 0 ? endTs - durMs : endTs
        bands.push({
          id: `term-${e.id}`,
          x0: toX(startTs),
          x1: toX(endTs),
          label: t('timeline.boundaries.termLabelFmt', { id: tid.slice(0, 4) }),
          kind: 'term'
        })
      }
    }
    let openPause: RedLogEvent | null = null
    for (const e of events) {
      if (e.agentType !== 'system') continue
      const sub = e.data?.subtype as string | undefined
      if (sub === 'recording_paused') {
        // v0.9.3: bug fix. Old code overwrote `openPause` silently on a
        // second paused-without-resume, losing the first band. Close the
        // prior band at the new pause's timestamp so BOTH paused events
        // remain visible in the track (as adjacent bands with no gap).
        // Adjacent-with-no-gap = "recording was paused twice, never
        // resumed in between" — audit-truthful, not a fabricated resume.
        if (openPause) {
          bands.push({
            id: `paused-${openPause.id}`,
            x0: toX(openPause.timestamp),
            x1: toX(e.timestamp),
            label: t('timeline.boundaries.pausedLabel'),
            kind: 'paused'
          })
        }
        openPause = e
      } else if (sub === 'recording_resumed' && openPause) {
        bands.push({
          id: `paused-${openPause.id}`,
          x0: toX(openPause.timestamp),
          x1: toX(e.timestamp),
          label: t('timeline.boundaries.pausedLabel'),
          kind: 'paused'
        })
        openPause = null
      }
    }
    if (openPause) {
      bands.push({
        id: `paused-${openPause.id}-open`,
        x0: toX(openPause.timestamp),
        x1: toX(Math.min(Date.now(), timeEnd)),
        label: t('timeline.boundaries.pausedLabel'),
        kind: 'paused'
      })
    }
    return bands
  }, [events, sessionDividers, toX, t, timeEnd])

  // Density minimap: event counts over the full range, binned into fixed cells.
  const bins = useMemo(() => {
    const N = 120
    const counts = new Array(N).fill(0)
    const span = (timeEnd - timeStart) || 1
    for (const e of events) {
      // v0.9.4 P0-4: bin on `displayTs` so the density histogram agrees with
      // the track. Binning on `timestamp` put an `atTimestamp`-overridden
      // marker in a different cell than the dot the operator can see.
      let i = Math.floor(((displayTs(e) - timeStart) / span) * N)
      i = i < 0 ? 0 : i >= N ? N - 1 : i
      counts[i]++
    }
    return { counts, max: Math.max(1, ...counts), N }
  }, [events, timeStart, timeEnd])

  // Keep the minimap's "current viewport" window in sync with the scroll/zoom.
  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el || TRACK_W <= 0) return
    setView({ left: (el.scrollLeft / TRACK_W) * 100, width: Math.min(100, (el.clientWidth / TRACK_W) * 100) })
    // v0.6.91 W2: track "am I at the right edge" so the follow badge can flip
    // between LIVE and behind. 10px slop covers scrollbar rounding and pixel
    // snapping across DPRs.
    setAtRightEdge(el.scrollLeft + el.clientWidth >= TRACK_W - 10)
    // Auto-load-more when scrolled to the earliest edge (audit #3). Was
    // click-driven with a "load more" chip; users hitting the left edge with
    // more history to pull would just see empty space and not realise there
    // was a button.
    if (!allLoaded && !loading && el.scrollLeft < 80) loadMore()
  }, [TRACK_W, allLoaded, loading, loadMore])

  // v0.6.91 W2: follow mode auto-scroll. When enabled AND the operator was
  // at the right edge, snap to the new right edge whenever fresh events land
  // (or the track's virtual width grows). We piggyback on `events` changing
  // rather than the onNew callback so a batch of events arriving in the same
  // frame only produces one scroll write.
  useEffect(() => {
    if (!followMode || !atRightEdge) return
    const el = scrollRef.current
    if (!el || TRACK_W <= 0) return
    el.scrollLeft = Math.max(0, TRACK_W - el.clientWidth)
  }, [events, followMode, atRightEdge, TRACK_W])

  // Drag across the minimap to zoom the main view to that window; click to jump.
  const onMinimapDown = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const w = rect.width
    const clamp = (v: number): number => Math.max(0, Math.min(v, w))
    const startX = clamp(e.clientX - rect.left)
    setCluster(null)
    const onMove = (me: MouseEvent): void => setDrag({ x0: startX, x1: clamp(me.clientX - rect.left), w })
    const onUp = (ue: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDrag(null)
      const el = scrollRef.current
      if (!el) return
      const endX = clamp(ue.clientX - rect.left)
      const span = (timeEnd - timeStart) || 1
      if (Math.abs(endX - startX) > 4) {
        const f0 = Math.min(startX, endX) / w
        const frac = Math.max(0.01, Math.abs(endX - startX) / w)
        pendingView.current = { t0: timeStart + f0 * span }
        setZoom(Math.max(0.25, Math.min(6, el.clientWidth / (BASE_TRACK_W * frac))))
      } else {
        const t = timeStart + (startX / w) * span
        el.scrollLeft = Math.max(0, Math.min(((t - timeStart) / span) * TRACK_W - el.clientWidth / 2, TRACK_W - el.clientWidth))
        updateView()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    setDrag({ x0: startX, x1: startX, w })
  }, [timeStart, timeEnd, TRACK_W, updateView])

  const recentEvents = useMemo(() => {
    const visible = events.filter((e) => !hiddenLanes.has(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)))
    return [...visible].reverse().slice(0, 50)
  }, [events, hiddenLanes, pluginTypes])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setCluster(null)
        const cursorX = e.clientX - el.getBoundingClientRect().left
        pendingZoomAnchor.current = { frac: (el.scrollLeft + cursorX) / TRACK_W, cursorX }
        // Proportional zoom: a trackpad pinch (macOS sends it as ctrl+wheel) fires
        // many small events — a fixed step per event slammed straight to the limit
        // and felt like nothing happened. Scaling by deltaY makes pinch smooth and
        // still gives a mouse wheel a reasonable step.
        setZoom((prev) => Math.min(6, Math.max(0.25, prev * Math.exp(-e.deltaY * 0.002))))
      } else if (e.deltaY !== 0) {
        // v0.9.4 P0-2: while the lane stack overflows its container, deltaY
        // has to drive the vertical axis or the newly-scrollable lanes are
        // unreachable by wheel; shift+wheel keeps the horizontal scroll that
        // deltaY does otherwise (dragging and the minimap also still pan).
        // With no vertical overflow — the common case — behaviour is
        // unchanged.
        const outer = containerRef.current
        if (outer && !e.shiftKey && outer.scrollHeight > outer.clientHeight + 1) return
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [TRACK_W])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Bug: this ran on every mousedown INSIDE the scroll track, including a
    // mousedown that started a click on the cluster popup. It would close
    // the popup + start drag before the popup <button>'s onClick had a
    // chance to fire — the operator saw "click a row in the popup, popup
    // closes, nothing happens" instead of the intended jump.
    // Fix: bail if the mousedown target is inside the cluster popup.
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-timeline-popup]')) return
    setCluster(null)
    isDragging.current = true
    dragStart.current = { x: e.clientX, scroll: scrollRef.current?.scrollLeft ?? 0 }
    document.body.classList.add('timeline-grabbing')
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!isDragging.current || !scrollRef.current) return
      const dx = e.clientX - dragStart.current.x
      scrollRef.current.scrollLeft = dragStart.current.scroll - dx
    }
    const onUp = (): void => {
      isDragging.current = false
      document.body.classList.remove('timeline-grabbing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // On open, jump the viewport to the present so the newest activity is in view
  // rather than the oldest. Runs once, after the first events have loaded and the
  // track has a real width. Manual pan/zoom afterwards is left untouched.
  // Reset the "already scrolled" flag whenever the caller changes what we
  // should scroll to. Prior behaviour set the ref once at first-open and
  // never cleared it — so a second click on a Loot item (after coming back
  // to Timeline) would silently short-circuit (audit finding P0 #7).
  useEffect(() => { didScrollToNow.current = false }, [focusEventId, focusTs])

  useEffect(() => {
    if (loading || didScrollToNow.current) return
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    // Jumping from Loot (or elsewhere) focuses a specific event: select it and
    // centre it. Otherwise land on the present, latest activity in view.
    const focused = focusEventId ? events.find((e) => e.id === focusEventId) : null
    if (focused) {
      setSelectedEvent(focused)
      el.scrollLeft = Math.max(0, Math.min(toX(focused.timestamp) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else if (focusTs) {
      // no matching event (e.g. jumped from a quickmark) — centre on its time
      el.scrollLeft = Math.max(0, Math.min(toX(focusTs) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else {
      el.scrollLeft = Math.max(0, Math.min(toX(Date.now()) - el.clientWidth + 80, TRACK_W - el.clientWidth))
    }
    didScrollToNow.current = true
  }, [loading, toX, TRACK_W, focusEventId, focusTs, events])

  // After a cursor-anchored zoom re-renders with the new TRACK_W, restore the
  // scroll so the timestamp that was under the pointer stays under the pointer.
  useLayoutEffect(() => {
    const a = pendingZoomAnchor.current
    const el = scrollRef.current
    if (!a || !el) return
    pendingZoomAnchor.current = null
    el.scrollLeft = a.frac * TRACK_W - a.cursorX
  }, [TRACK_W])

  // After a minimap drag-to-zoom re-renders, place the selected window at the
  // left edge; then refresh the viewport indicator whenever the track resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingView.current) {
      const { t0 } = pendingView.current
      pendingView.current = null
      const span = (timeEnd - timeStart) || 1
      el.scrollLeft = Math.max(0, Math.min(((t0 - timeStart) / span) * TRACK_W, TRACK_W - el.clientWidth))
    }
    // Cluster-item click scheduled a center-scroll for after zoom re-render.
    if (el && pendingCenterTs.current !== null) {
      const ts = pendingCenterTs.current
      pendingCenterTs.current = null
      el.scrollLeft = Math.max(0, Math.min(toX(ts) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    }
    updateView()
  }, [TRACK_W, updateView, timeStart, timeEnd, loading])

  const toggleLane = useCallback((lane: LaneId) => {
    setHiddenLanes((prev) => {
      const next = new Set(prev)
      if (next.has(lane)) next.delete(lane)
      else if (next.size < LANES.length - 1) next.add(lane)
      return next
    })
  }, [])

  // Alt/Option-click a lane chip: solo that lane (hide every other populated
  // lane). Alt-click again on the same solo'd lane: show all. Audit #4 —
  // reviewing an engagement typically starts with "show only shell", which
  // took 13 clicks before.
  const soloLane = useCallback((lane: LaneId, populated: Set<LaneId>) => {
    setHiddenLanes((prev) => {
      const others = new Set<LaneId>()
      for (const l of populated) if (l !== lane) others.add(l)
      // If already solo'd (this lane is the ONLY visible one), toggle back
      // to show all — otherwise apply the solo.
      const isSolo = !prev.has(lane) && [...populated].every((l) => l === lane || prev.has(l))
      return isSolo ? new Set() : others
    })
  }, [])
  const showAllLanes = useCallback(() => setHiddenLanes(new Set()), [])

  // Escape closes the event detail panel (audit finding #78). ↑/↓ walk the
  // selected event across the visible list, respecting hidden-lane filters —
  // audit #5. Skips inputs/textareas so typing in the search bar isn't hijacked.
  useEffect(() => {
    if (!selectedEvent) return
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
      if (e.key === 'Escape') { setSelectedEvent(null); setShowJson(false); return }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const visible = events.filter((ev) => !hiddenLanes.has(toLane(ev.agentType, ev.data?.subtype as string | undefined, pluginTypes)))
        const i = visible.findIndex((ev) => ev.id === selectedEvent.id)
        if (i < 0) return
        const dir = e.key === 'ArrowUp' ? -1 : 1
        const next = visible[i + dir]
        if (next) { e.preventDefault(); setSelectedEvent(next) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedEvent, events, hiddenLanes])

  // v0.6.91 W1: `/` focuses the header filter input. Escape (while the input
  // is focused) clears the query AND blurs. Skipped when the user is already
  // typing in another input, so `/` inside a shell command doesn't hijack it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      const inField = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable
      if (e.key === '/' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // v0.9.3 U2: `?` toggles the shortcut cheatsheet. Same skip-when-typing
  // guard as the other global keys so `?` inside a shell command / search
  // input isn't hijacked. Esc also closes when the modal is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      const inField = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable
      if (inField) return
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setShowHelp((s) => !s)
        return
      }
      if (e.key === 'Escape' && showHelp) {
        e.preventDefault()
        setShowHelp(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showHelp])

  // v0.6.89.5 feature 2: `f` shortcut to enter/exit focus chain mode.
  // Anchor priority: currently-selected event, then the event under the
  // mouse (last hovered dot). Escape also exits. Skipped when the user is
  // typing in an input or contenteditable to avoid hijacking search boxes.
  const hoveredEventRef = useRef<RedLogEvent | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
      if (e.key === 'Escape' && focusChain) {
        setFocusAnchorId(null)
        return
      }
      if (e.key !== 'f' && e.key !== 'F') return
      // ignore modifier combos so this doesn't collide with ⌘F etc.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const anchor = selectedEvent ?? hoveredEventRef.current
      if (!anchor) return
      e.preventDefault()
      if (focusAnchorId === anchor.id) {
        // toggle off — press f again on the same anchor exits focus.
        setFocusAnchorId(null)
      } else {
        setFocusAnchorId(anchor.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedEvent, focusChain, focusAnchorId])

  // v0.6.91 W3: palette result set — fuzzy match query against events, marker
  // titles, distinct operator names, and distinct hosts. Capped at 20 items.
  type PaletteItem =
    | { kind: 'event' | 'marker'; event: RedLogEvent; label: string; sub: string; score: number; ts: number }
    | { kind: 'operator' | 'host'; value: string; label: string; sub: string; score: number; ts: number }
  const paletteResults = useMemo<PaletteItem[]>(() => {
    const q = paletteQuery.trim()
    if (!q) return []
    const items: PaletteItem[] = []
    for (const e of events) {
      const d = e.data as Record<string, unknown> | undefined
      const fields = [
        eventTitle(e),
        String(d?.command ?? ''),
        String(d?.url ?? ''),
        String(d?.host ?? ''),
        String(d?.title ?? ''),
        String(d?.subtype ?? '')
      ]
      let best = -1
      for (const f of fields) { const s = fuzzyScore(f, q); if (s > best) best = s }
      if (best > 0) {
        items.push({
          kind: e.agentType === 'marker' ? 'marker' : 'event',
          event: e,
          label: eventTitle(e),
          sub: e.agentType,
          score: best,
          ts: e.timestamp
        })
      }
    }
    const seenOp = new Set<string>()
    for (const [id, name] of Object.entries(operatorNames)) {
      const s = Math.max(fuzzyScore(name, q), fuzzyScore(id, q))
      if (s > 0 && !seenOp.has(name)) {
        seenOp.add(name)
        items.push({ kind: 'operator', value: name, label: name, sub: id, score: s, ts: 0 })
      }
    }
    const hosts = new Set<string>()
    for (const e of events) {
      const h = e.data?.host as unknown
      if (typeof h === 'string' && h) hosts.add(h)
    }
    for (const h of hosts) {
      const s = fuzzyScore(h, q)
      if (s > 0) items.push({ kind: 'host', value: h, label: h, sub: 'host', score: s, ts: 0 })
    }
    items.sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
    return items.slice(0, 20)
  }, [events, operatorNames, paletteQuery])
  useEffect(() => {
    if (paletteIndex >= paletteResults.length) setPaletteIndex(Math.max(0, paletteResults.length - 1))
  }, [paletteResults, paletteIndex])

  // Helper: scroll the track so the given event is centred in the viewport.
  // Used by the cause/effect chips (feature 1) and any other jump-to-event
  // interaction; it uses `displayTs` so a marker with an override timestamp
  // still lands under its rendered position instead of its wall-clock one.
  const scrollToEvent = useCallback((evt: RedLogEvent) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, Math.min(toX(displayTs(evt)) - el.clientWidth / 2, TRACK_W - el.clientWidth))
  }, [toX, TRACK_W])

  // v0.6.91 W3: activate a palette result. Events / markers → select + centre.
  // Operator / host → drop the value into the filter query (feature 1 dim path
  // picks it up automatically).
  const activatePaletteItem = useCallback((item: PaletteItem) => {
    if (item.kind === 'event' || item.kind === 'marker') {
      setSelectedEvent(item.event)
      scrollToEvent(item.event)
    } else {
      setFilterQuery(item.value)
    }
    setPaletteOpen(false)
    setPaletteQuery('')
  }, [scrollToEvent])

  // v0.6.91 S1: save current Timeline state as a named view. Snapshots the
  // minimap window (in wall-clock ms), zoom, hidden lanes, and filter query.
  const saveCurrentView = useCallback(async (name: string): Promise<void> => {
    if (!viewsApi?.save) return
    const trimmed = name.trim()
    if (!trimmed) return
    const span = (timeEnd - timeStart) || 1
    const winStart = Math.round(timeStart + (view.left / 100) * span)
    const winEnd = Math.round(timeStart + ((view.left + view.width) / 100) * span)
    try {
      await viewsApi.save({
        name: trimmed,
        state: {
          timeStart: winStart,
          timeEnd: winEnd,
          zoom,
          hiddenLanes: [...hiddenLanes],
          filterQuery
        }
      })
      setViewsName('')
      await refreshViews()
      toast('Saved', 'success')
    } catch { toast('Save failed', 'error') }
  }, [viewsApi, timeStart, timeEnd, view, zoom, hiddenLanes, filterQuery, refreshViews, t])

  const applyView = useCallback((v: SavedTimelineView) => {
    const s = v.state ?? {}
    if (typeof s.zoom === 'number' && s.zoom >= 0.25 && s.zoom <= 6) setZoom(s.zoom)
    if (Array.isArray(s.hiddenLanes)) {
      setHiddenLanes(new Set(s.hiddenLanes.filter((l): l is LaneId => LANES.includes(l as LaneId))))
    }
    if (typeof s.filterQuery === 'string') setFilterQuery(s.filterQuery)
    // Time-window restore — schedule the same pendingView handshake the
    // minimap-drag path uses so the scroll lands after the next TRACK_W paint.
    if (typeof s.timeStart === 'number' && typeof s.timeEnd === 'number' && s.timeEnd > s.timeStart) {
      pendingView.current = { t0: s.timeStart }
    }
    setViewsOpen(false)
  }, [])

  const deleteView = useCallback(async (id: string) => {
    if (!viewsApi?.delete) return
    try { await viewsApi.delete(id) } catch { /* ignore */ }
    await refreshViews()
  }, [viewsApi, refreshViews])

  const copyEventJson = useCallback(() => {
    if (!selectedEvent) return
    // Respect the current mask/reveal state (audit finding #2). If the panel
    // shows a masked view, the clipboard gets the masked view too — a
    // reviewer copying an event to paste into chat / a report shouldn't have
    // to remember to hit Reveal first to know what they're leaking. Click
    // Reveal → then Copy → gets raw. Default (mask) → Copy → gets masked.
    const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
    const revealed = revealedEvents.has(selectedEvent.id)
    const shown = revealed || !spans?.length
      ? selectedEvent
      : { ...selectedEvent, data: maskEventData(selectedEvent.data ?? {}, spans) }
    navigator.clipboard.writeText(JSON.stringify(shown, null, 2))
    toast(t(revealed || !spans?.length ? 'toast.copied' : 'toast.copiedMasked'), 'success')
  }, [selectedEvent, revealedEvents, t])

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner label={t('common.loading')} />
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center px-8">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <span className="text-2xl text-zinc-700">═</span>
          </div>
          <p className="text-sm text-zinc-500">{t('timeline.noEvents')}</p>
          <p className="text-xs text-zinc-700">{t('timeline.noEventsDesc')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full relative">
      {/* v0.6.89.5 feature 5: broken-chain top banner. Sticks above the header
          so it can't be missed. Dismiss hides for the current mount only —
          the module cache still holds the result, so re-opening Timeline (or
          another verify producing the same brokenAt) brings it back. */}
      {verifyResult && verifyResult.brokenAtEventId && !verifyDismissed && (
        <div
          data-testid="timeline-broken-chain-banner"
          className="flex items-center gap-2 px-4 py-1.5 border-b border-red-800 bg-red-950/50 text-xs shrink-0"
        >
          <span className="text-red-300 font-mono">
            {t('timeline.brokenChain.banner', {
              brokenAtId: verifyResult.brokenAtEventId.slice(0, 8),
              walked: String(verifyResult.walked ?? 0)
            })}
          </span>
          <button
            onClick={() => setVerifyDismissed(true)}
            className="ml-auto text-[11px] text-red-300 hover:text-red-100 px-1.5 py-0.5 rounded bg-red-900/40 hover:bg-red-900/60 transition-colors"
          >
            {t('timeline.brokenChain.dismiss')}
          </button>
        </div>
      )}
      {/* v0.6.91 W3: ⌘K fuzzy palette. Fixed overlay so it sits above every
          other Timeline chrome. Escape closes. Enter activates the selected
          result. ↑/↓ move the highlight. Backdrop click also closes. */}
      {paletteOpen && (
        <div
          data-testid="timeline-palette"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
          onClick={(e) => { if (e.target === e.currentTarget) setPaletteOpen(false) }}
        >
          <div className="w-[560px] max-w-[92vw] rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl overflow-hidden">
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              onChange={(e) => { setPaletteQuery(e.target.value); setPaletteIndex(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setPaletteOpen(false); return }
                if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex((i) => Math.min(paletteResults.length - 1, i + 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex((i) => Math.max(0, i - 1)); return }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = paletteResults[paletteIndex]
                  if (item) activatePaletteItem(item)
                }
              }}
              placeholder={t('timeline.palette.placeholder')}
              className="w-full px-3 py-2 bg-zinc-950 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 border-b border-zinc-800 focus:outline-none"
            />
            <div className="max-h-[360px] overflow-y-auto">
              {paletteResults.length === 0 ? (
                <div className="px-3 py-4 text-xs text-zinc-500 font-mono text-center">{t('timeline.palette.noResults')}</div>
              ) : paletteResults.map((item, i) => {
                const groupKey = item.kind === 'event' ? 'timeline.palette.groupEvent'
                  : item.kind === 'marker' ? 'timeline.palette.groupMarker'
                  : item.kind === 'operator' ? 'timeline.palette.groupOperator'
                  : 'timeline.palette.groupHost'
                const isSel = i === paletteIndex
                return (
                  <button
                    key={item.kind === 'event' || item.kind === 'marker' ? item.event.id : `${item.kind}-${item.value}`}
                    onMouseEnter={() => setPaletteIndex(i)}
                    onClick={() => activatePaletteItem(item)}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${isSel ? 'bg-white/10' : 'hover:bg-white/5'}`}
                  >
                    <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 w-14 shrink-0">
                      {t(groupKey)}
                    </span>
                    <span className="text-xs font-mono text-zinc-200 truncate flex-1">{item.label}</span>
                    <span className="text-[10px] font-mono text-zinc-600 shrink-0">{item.sub}</span>
                  </button>
                )
              })}
            </div>
            <div className="px-3 py-1.5 border-t border-zinc-800 text-[10px] font-mono text-zinc-500 text-center">
              {t('timeline.palette.footer')}
            </div>
          </div>
        </div>
      )}
      {/* v0.9.3 U2: keyboard-shortcut cheatsheet modal. Same overlay
          pattern as the ⌘K palette — Escape and backdrop click both
          close. Grouped so operators can scan by task ("I want to
          filter" → look at the filter row) instead of memorising a
          flat list. */}
      {showHelp && (
        <div
          data-testid="timeline-help"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
          onClick={(e) => { if (e.target === e.currentTarget) setShowHelp(false) }}
        >
          <div className="w-[560px] max-w-[92vw] rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">{t('timeline.help.title')}</span>
              <button
                onClick={() => setShowHelp(false)}
                className="ml-auto text-xs text-zinc-500 hover:text-zinc-200 leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-white/10"
                aria-label={t('timeline.help.close')}
                title={t('timeline.help.close')}
              >×</button>
            </div>
            <div className="px-4 py-3 space-y-3 max-h-[70vh] overflow-y-auto">
              {([
                ['timeline.help.group.filter', [
                  ['/', 'timeline.help.slash'],
                  ['⌘K', 'timeline.help.palette'],
                  ['Alt-click', 'timeline.help.soloLane'],
                  ['Esc', 'timeline.help.escFilter']
                ]],
                ['timeline.help.group.focus', [
                  ['f', 'timeline.help.focusChain'],
                  ['click', 'timeline.help.selectDot'],
                  ['↑/↓', 'timeline.help.walk']
                ]],
                ['timeline.help.group.timeline', [
                  ['Right-click', 'timeline.help.dropMarker'],
                  ['drag minimap', 'timeline.help.zoom'],
                  ['click cluster', 'timeline.help.expandCluster']
                ]],
                ['timeline.help.group.detail', [
                  ['click ▶', 'timeline.help.expandBody'],
                  ['click cause chip', 'timeline.help.jumpCause'],
                  ['Copy full', 'timeline.help.copyFull']
                ]],
                ['timeline.help.group.misc', [
                  ['?', 'timeline.help.thisMenu']
                ]]
              ] as Array<[string, Array<[string, string]>]>).map(([groupKey, rows]) => (
                <div key={groupKey}>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">{t(groupKey)}</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    {rows.map(([key, descKey]) => (
                      <div key={key} className="contents">
                        <kbd className="font-mono text-[11px] text-zinc-200 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 whitespace-nowrap">{key}</kbd>
                        <span className="text-zinc-400">{t(descKey)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-3 py-1.5 border-t border-zinc-800 text-[10px] font-mono text-zinc-500 text-center">
              {t('timeline.help.footer')}
            </div>
          </div>
        </div>
      )}
      {/* v0.6.89.5 feature 2: focus-chain badge (top-right). Only rendered
          while focus mode is active. Anchored on the wrapper so it floats
          above the minimap without shifting layout. */}
      {focusChain && (
        <div
          data-testid="timeline-focus-badge"
          className="absolute z-40 flex items-center gap-2 px-2 py-1 rounded-md border border-cyan-500/50 bg-zinc-950/95 text-xs font-mono shadow-lg"
          style={{ top: 6, right: 8 }}
        >
          <span className="text-cyan-300">
            {t('timeline.focusChain.badge', { count: focusChain.size })}
          </span>
          <button
            onClick={() => setFocusAnchorId(null)}
            className="text-zinc-400 hover:text-zinc-100 leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
            title={t('timeline.focusChain.exit')}
            aria-label={t('timeline.focusChain.exit')}
          >×</button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/80 shrink-0">
        <span className="text-[13px] font-semibold text-zinc-200 tracking-wide">{t('timeline.title')}</span>
        <span className="text-[11px] text-zinc-600 font-mono tabular-nums">
          {t('timeline.events', { count: events.length })}
        </span>
        {!allLoaded && (
          <button onClick={loadMore} className="text-xs text-zinc-600 hover:text-zinc-300 ml-1 transition-colors">
            {t('timeline.loadMore')}
          </button>
        )}

        {/* v0.9.3 U2: keyboard-shortcut cheatsheet button. Every hotkey we
            shipped (⌘K palette, `/` search, `f` focus chain, right-click
            drop-marker, Alt-click solo, etc.) was invisible without prior
            knowledge — Design-review agent graded discoverability F. This
            makes the affordance visible; the modal itself lists everything. */}
        <button
          onClick={() => setShowHelp(true)}
          className="ml-1 w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          title={t('timeline.help.hint')}
          aria-label={t('timeline.help.hint')}
        >?</button>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.zoomOut')}
            aria-label={t('timeline.zoomOut')}
          >−</button>
          <button
            onClick={() => setZoom(1)}
            disabled={Math.abs(zoom - 1) < 0.01}
            className="px-1.5 h-5 flex items-center justify-center text-xs text-zinc-600 hover:text-zinc-300 bg-zinc-800/50 rounded font-mono tabular-nums transition-colors disabled:cursor-default disabled:hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.resetZoom')}
            aria-label={t('timeline.resetZoom')}
          >{Math.round(zoom * 100)}% ↺</button>
          <button
            onClick={() => setZoom((z) => Math.min(6, z + 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.zoomIn')}
            aria-label={t('timeline.zoomIn')}
          >+</button>
        </div>

        {/* v0.9.3 U3: collapse-agent-turns chip. Off by default (existing
            operators don't lose visibility on upgrade). When on, per-turn
            agent subtypes are dropped from the render pipeline — the
            hidden count is shown so the empty agent lane doesn't look
            like a bug. Same visual weight as the other filter chips. */}
        <button
          onClick={() => setCollapseAgentTurns((v) => !v)}
          title={collapseAgentTurns
            ? t('timeline.collapseAgent.hidden', { count: hiddenAgentTurnCount })
            : t('timeline.collapseAgent.hint')}
          className={`ml-2 px-2 h-5 flex items-center gap-1 text-[11px] rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${collapseAgentTurns ? 'bg-lime-900/40 text-lime-300 hover:bg-lime-900/60' : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'}`}
        >
          <span>{collapseAgentTurns ? '⇘' : '⇗'}</span>
          <span className="font-mono">{t('timeline.collapseAgent.label')}</span>
          {collapseAgentTurns && hiddenAgentTurnCount > 0 && (
            <span className="font-mono tabular-nums text-[10px] text-lime-400/80">−{hiddenAgentTurnCount}</span>
          )}
        </button>

        {/* v0.6.91 W1: inline `/` filter. Always visible in the header so
            operators can see there's a text filter (previously discoverable
            only by shortcut). Icon prefix + clear button on the right. */}
        <div className="relative flex items-center ml-2">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] text-zinc-600 pointer-events-none font-mono">/</span>
          <input
            ref={searchInputRef}
            data-testid="timeline-search-input"
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (filterQuery) { setFilterQuery(''); e.preventDefault() }
                else searchInputRef.current?.blur()
              }
            }}
            placeholder={t('timeline.search.placeholder')}
            title={t('timeline.search.hint')}
            className="pl-5 pr-6 py-0.5 h-6 w-[220px] text-xs font-mono bg-zinc-900/70 border border-zinc-800 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          {filterQuery && (
            <button
              onClick={() => setFilterQuery('')}
              title={t('timeline.search.clear')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
            >×</button>
          )}
        </div>

        {/* v0.6.91 W2: LIVE / behind badge. Green = at the right edge with
            follow on; grey/amber = scrolled back into history. Click →
            snap to now + re-enable follow. Little icon button toggles the
            follow mode without jumping. */}
        {(() => {
          const latestTs = events.length > 0 ? events[events.length - 1].timestamp : 0
          const behindMs = Math.max(0, now - latestTs)
          const isLive = atRightEdge && followMode
          const label = isLive
            ? t('timeline.follow.live')
            : t('timeline.follow.behindFmt', { time: formatBehind(behindMs) })
          return (
            <div className="flex items-center gap-1">
              <button
                data-testid="timeline-follow-badge"
                onClick={() => {
                  const el = scrollRef.current
                  if (el && TRACK_W > 0) el.scrollLeft = Math.max(0, TRACK_W - el.clientWidth)
                  setFollowMode(true)
                }}
                title={isLive ? t('timeline.follow.jumpToNow') : t('timeline.follow.jumpToNow')}
                className={`whitespace-nowrap text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
                  isLive
                    ? 'text-emerald-100 bg-emerald-600/40 ring-1 ring-emerald-500/40'
                    : 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
                }`}
              >{label}</button>
              <button
                onClick={() => setFollowMode((v) => !v)}
                title={followMode ? t('timeline.follow.pauseHint') : t('timeline.follow.resumeHint')}
                aria-label={followMode ? t('timeline.follow.pauseHint') : t('timeline.follow.resumeHint')}
                className="w-5 h-5 flex items-center justify-center text-[10px] text-zinc-500 hover:text-zinc-200 bg-zinc-800/60 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              >{followMode ? '⏸' : '▶'}</button>
            </div>
          )
        })()}

        {/* Lane filter toggles — click toggles; Alt/Option-click solos the
            lane (hides every other populated lane); solo'd-lane Alt-click
            again shows all. Audit finding #4.
            `overflow-x-auto` + `min-w-0` + `flex-nowrap` means when the
            header narrows the chips scroll horizontally instead of wrapping
            onto a second row — reported when running at 1280 wide with the
            full lane list open. */}
        <div className="ml-auto flex flex-nowrap gap-1 items-center overflow-x-auto min-w-0">
          {/* v0.6.91 S1: Views dropdown. Save current view + list. Kept as a
              plain <details>-style toggle so keyboard tab-order and focus
              rings stay predictable across platforms. */}
          <div className="relative shrink-0">
            <button
              data-testid="timeline-views-dropdown"
              onClick={() => setViewsOpen((v) => !v)}
              className="whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              aria-expanded={viewsOpen}
            >★ {t('timeline.views.button')}</button>
            {viewsOpen && (
              <div className="absolute top-full right-0 mt-1 z-40 w-72 rounded border border-zinc-700 bg-zinc-900/95 shadow-xl">
                <div className="px-2 py-1.5 border-b border-zinc-800">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">{t('timeline.views.saveNew')}</div>
                  <input
                    value={viewsName}
                    onChange={(e) => setViewsName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { void saveCurrentView(viewsName) }
                      if (e.key === 'Escape') setViewsOpen(false)
                    }}
                    placeholder={t('timeline.views.saveNamePlaceholder')}
                    title={t('timeline.views.saveHint')}
                    className="w-full px-2 py-1 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {savedViews === null && (
                    <div className="px-2 py-2 text-[11px] text-zinc-500 font-mono">…</div>
                  )}
                  {savedViews && savedViews.length === 0 && (
                    <div className="px-2 py-2 text-[11px] text-zinc-500 font-mono">{t('timeline.views.empty')}</div>
                  )}
                  {savedViews && savedViews.map((v) => (
                    <div key={v.id} className="flex items-center gap-1 px-2 py-1 hover:bg-white/5">
                      <button
                        onClick={() => applyView(v)}
                        className="flex-1 text-left text-xs font-mono text-zinc-200 truncate"
                        title={v.name}
                      >{v.name}</button>
                      <span className="text-[10px] font-mono text-zinc-600 tabular-nums">
                        {formatTs(v.createdAt, tz, projectTz, 'time')}
                      </span>
                      <button
                        onClick={() => void deleteView(v.id)}
                        title={t('timeline.views.delete')}
                        aria-label={t('timeline.views.delete')}
                        className="text-zinc-500 hover:text-red-400 leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
                      >×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* v0.6.91 S3: session boundaries visibility toggle. */}
          <button
            onClick={() => setSessionDividers((v) => !v)}
            className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${
              sessionDividers ? 'text-indigo-300 bg-indigo-500/10' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]'
            }`}
            title={t('timeline.boundaries.toggle')}
            aria-pressed={sessionDividers}
          >⋮ {t('timeline.boundaries.toggle')}</button>

          {/* v0.6.91 S7: timezone selector. Wraps a <select> because the
              alternative (three chips) uses more header real-estate than we
              can afford at 1280 width. */}
          <select
            data-testid="timeline-tz-select"
            value={tz}
            onChange={(e) => setTz(e.target.value as TzMode)}
            title={t('timeline.tz.tooltip')}
            className="shrink-0 whitespace-nowrap text-xs px-1 py-0.5 rounded font-mono bg-zinc-800/60 text-zinc-300 border border-zinc-700 hover:bg-zinc-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            <option value="local">🕓 {t('timeline.tz.local')}</option>
            <option value="utc">🕓 {t('timeline.tz.utc')}</option>
            <option value="project" disabled={!projectTz}>🕓 {t('timeline.tz.project')}{projectTz ? ` (${projectTz})` : ''}</option>
          </select>

          {/* v0.6.89.5 feature 4: anomaly filter — dims every event without an
              integrity badge (clock anomaly / recovery / evidence removal /
              anchor failure / chain break). First chip so it's the fastest
              thing to reach when a verify caught something. Disabled at
              opacity 0.25 when there's nothing to filter. Mutually exclusive
              with focus-chain mode (both use dim opacity 0.15). */}
          <button
            data-testid="timeline-anomaly-chip"
            onClick={() => {
              if (anomalyCount === 0) return
              setAnomalyFilter((v) => !v)
            }}
            disabled={anomalyCount === 0}
            className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 ${
              anomalyCount === 0
                ? 'opacity-25 cursor-default text-zinc-600'
                : anomalyFilter
                  ? 'text-amber-200 bg-amber-500/25 ring-1 ring-amber-500/40'
                  : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
            }`}
            title={anomalyCount === 0 ? t('timeline.anomalies.tooltip') : t('timeline.anomalies.tooltip')}
          >
            {t('timeline.anomalies.chip', { count: anomalyCount })}
          </button>
          {/* v0.6.87 C2: export the currently-visible time window as JSON.
              The window is derived from the minimap view (left..left+width in
              percent) mapped back to (timeStart..timeEnd). Bug-bounty writeups
              zoom to the attack moment then click this to grab an evidence
              slice. Saved under exports/redlog-timeline-<ts>.json. */}
          <button
            onClick={async () => {
              if (!window.redlog.data.exportTimelineSlice) return
              const from = Math.round(timeStart + (view.left / 100) * (timeEnd - timeStart))
              const to = Math.round(timeStart + ((view.left + view.width) / 100) * (timeEnd - timeStart))
              const path = await window.redlog.data.exportTimelineSlice(from, to)
              if (path) toast(t('timeline.exportSliceOk', { path }), 'success')
              else toast(t('timeline.exportSliceFail'), 'error')
            }}
            className="shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-zinc-500 hover:text-emerald-400 hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
            title={t('timeline.exportSliceHint')}
          >⬇ {t('timeline.exportSlice')}</button>
          {hiddenLanes.size > 0 && (
            <button
              onClick={showAllLanes}
              className="shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              title={t('timeline.showAllLanes')}
            >{t('timeline.showAll')}</button>
          )}
          {LANES.map((id) => {
            const empty = !populatedLanes.has(id)
            const hidden = hiddenLanes.has(id)
            const off = empty || hidden
            const externalOnly = EXTERNAL_ONLY_LANES.has(id)
            // v0.6.97 F: external-only lanes (credential_use, c2_checkin)
            // stay hidden on an internal engagement — pre-v0.6.97 they
            // rendered dimmed with a tooltip, but on a laptop-only pentest
            // they'll never populate and just clutter the chip row. Once a
            // real event lands they auto-reappear (populatedLanes shifts).
            if (externalOnly && empty) return null
            return (
              <button
                key={id}
                onClick={(e) => { if (empty) return; if (e.altKey) soloLane(id, populatedLanes); else toggleLane(id) }}
                disabled={empty}
                className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${
                  hidden ? 'opacity-30 line-through' : empty ? 'opacity-25 cursor-default' : ''
                }`}
                style={{
                  color: off ? '#525252' : LANE_COLORS[id],
                  backgroundColor: off ? 'transparent' : `${LANE_COLORS[id]}10`
                }}
                title={empty
                  ? externalOnly ? t('timeline.laneExternalOnly', { lane: laneLabels[id] }) : t('timeline.laneEmpty', { lane: laneLabels[id] })
                  : t('timeline.laneChipHint', { lane: laneLabels[id] })}
              >
                {laneLabels[id]}
              </button>
            )
          })}
        </div>
      </div>

      {/* Density minimap — overview of the whole engagement. Drag to zoom to a
          window, click to jump. The bright frame marks the current viewport. */}
      <div
        className="relative h-9 border-b border-zinc-800/80 bg-zinc-950/40 cursor-crosshair select-none shrink-0"
        onMouseDown={onMinimapDown}
        title={t('timeline.minimapHint')}
      >
        <div className="absolute inset-0 flex items-end gap-px px-1 pb-0.5">
          {bins.counts.map((c, i) => (
            <div key={i} className="flex-1 rounded-sm bg-cyan-500/40" style={{ height: c ? `${18 + (c / bins.max) * 72}%` : '0%' }} />
          ))}
        </div>
        <div
          className="absolute inset-y-0 border-x-2 border-cyan-300/70 bg-cyan-300/10 pointer-events-none"
          style={{ left: `${view.left}%`, width: `${Math.max(1, view.width)}%` }}
        />
        {drag && (
          <div
            className="absolute inset-y-0 bg-white/15 border border-white/50 pointer-events-none"
            style={{ left: `${(Math.min(drag.x0, drag.x1) / drag.w) * 100}%`, width: `${(Math.abs(drag.x1 - drag.x0) / drag.w) * 100}%` }}
          />
        )}
      </div>

      {/* Timeline + event list split */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Swim lanes */}
        {/* v0.9.4 P0-2: scrolls vertically. The lane labels are a sibling of
            the track, so the overflow has to live on this shared parent —
            putting it on the track alone would slide the lanes out from
            under their labels. 18 lanes x the 36px floor overflows a 1080p
            window, and the old `overflow-hidden` clipped the tail of the
            stack (scope / process / system) with no scrollbar and no hint. */}
        <div ref={containerRef} className="flex-1 min-h-0 flex overflow-x-hidden overflow-y-auto">
          {/* Lane labels */}
          <div className="shrink-0 border-r border-zinc-800/60 bg-zinc-950/50" style={{ width: LABEL_W }}>
            <div className="h-7 border-b border-zinc-800/60" />
            {visibleLanes.map((id) => (
              <div
                key={id}
                className="flex items-center gap-1.5 px-2 border-b border-zinc-800/30 font-mono text-[11px]"
                style={{ height: laneH }}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[id] }} />
                <span className="text-zinc-500 truncate">{laneLabels[id]}</span>
              </div>
            ))}
          </div>

          {/* Scrollable track */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden cursor-grab"
            onMouseDown={handleMouseDown}
            onScroll={updateView}
            onContextMenu={(e) => {
              // v0.6.87 C1: right-click on the timeline background drops a
              // marker at the clicked timestamp. Skips when the click landed
              // on an event dot (they have their own click handler) or on
              // the cluster popup.
              if (!onDropMarker) return
              const target = e.target as HTMLElement | null
              if (target?.closest('[data-timeline-popup]')) return
              if (target?.closest('[data-timeline-event]')) return
              e.preventDefault()
              const el = scrollRef.current
              if (!el || timeSpan <= 0) return
              const rect = el.getBoundingClientRect()
              const trackX = (e.clientX - rect.left) + el.scrollLeft
              const ts = timeStart + (trackX / TRACK_W) * timeSpan
              onDropMarker(Math.round(ts))
            }}
          >
            <div style={{ width: TRACK_W, position: 'relative' }}>
              {/* Time axis */}
              <div className="h-7 border-b border-zinc-800/60 relative bg-zinc-950/30">
                {ticks.map((ts) => (
                  <span
                    key={ts}
                    className="absolute text-xs text-zinc-600 font-mono tabular-nums -translate-x-1/2"
                    style={{ left: toX(ts), top: 6 }}
                  >
                    {formatTs(ts, tz, projectTz, 'time')}
                  </span>
                ))}
              </div>

              {/* Lanes area */}
              <div style={{ height: totalH, position: 'relative' }}>
                {visibleLanes.map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-full border-b border-zinc-800/30"
                    style={{
                      top: i * laneH,
                      height: laneH,
                      backgroundColor: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.008)'
                    }}
                  />
                ))}
                {ticks.map((ts) => (
                  <div
                    key={ts}
                    className="absolute top-0 border-l border-zinc-800/25"
                    style={{ left: toX(ts), height: totalH }}
                  />
                ))}
                {/* v0.6.91 S3: session boundary bands. Rendered before the
                    current-time line and the broken-chain band so those
                    stronger overlays win. Paused-recording bands use a
                    diagonal stripe fill; terminal bands are a flat tint. */}
                {sessionBands.map((b) => {
                  const w = Math.max(0, b.x1 - b.x0)
                  if (w <= 0) return null
                  const bg = b.kind === 'paused'
                    ? 'repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px)'
                    : 'rgba(99, 102, 241, 0.02)'
                  const border = b.kind === 'paused' ? 'rgba(148,163,184,0.35)' : 'rgba(99,102,241,0.30)'
                  return (
                    <div key={b.id} className="absolute top-0 pointer-events-none" style={{ left: b.x0, width: w, height: totalH }}>
                      <div className="absolute inset-0" style={{ background: bg }} />
                      <div className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: border }} />
                      <div className="absolute inset-y-0 right-0 border-l border-dashed" style={{ borderColor: border }} />
                      <span
                        className="absolute top-0 text-[9px] font-mono px-1 rounded-b bg-zinc-900/80"
                        style={{ left: 2, color: b.kind === 'paused' ? '#cbd5e1' : '#a5b4fc' }}
                      >{b.label}</span>
                    </div>
                  )
                })}
                {/* Current time line */}
                {Date.now() >= timeStart && Date.now() <= timeEnd && (
                  <div className="absolute top-0 w-px bg-red-500/70" style={{ left: toX(Date.now()), height: totalH }} />
                )}
                {/* v0.6.89.5 feature 5: red-tinted band behind every event
                    that landed AFTER the broken-chain event. Rendered before
                    the dots so it sits underneath but above the lane
                    background. */}
                {brokenAtId && (() => {
                  const brokenEvt = eventsMapRef.current.get(brokenAtId)
                  if (!brokenEvt) return null
                  const x0 = toX(displayTs(brokenEvt))
                  return (
                    <div
                      className="absolute top-0 bg-red-500/5 border-l border-red-500/30 pointer-events-none"
                      style={{ left: x0, width: Math.max(0, TRACK_W - x0), height: totalH }}
                    />
                  )
                })()}
                {/* Event markers — single dot, or a counted cluster when dense */}
                {clusters.map((c) => {
                  const single = c.events.length === 1
                  const evt = c.events[0]
                  const sel = single && selectedEvent?.id === evt.id
                  const dot = single ? 9 : Math.min(24, 13 + Math.round(Math.log2(c.events.length) * 3))
                  const hit = Math.max(20, dot + 8)
                  // v0.6.89.5: filter dimming. Focus-chain and anomaly-filter
                  // are mutually exclusive (enforced by the effects above), so
                  // at most one of these is truthy at any time. A cluster is
                  // "active" (not dimmed) if ANY event in it is in the
                  // active set — so a 20-event burst that contains a chain
                  // link doesn't disappear.
                  // v0.6.91 W1: filter query joins focus-chain and anomaly-filter
                  // as the third dim mode. The three are mutually exclusive
                  // (enforced by the effects above), so at most one branch fires.
                  let dimmed = false
                  if (focusChain) {
                    dimmed = !c.events.some((e) => focusChain.has(e.id))
                  } else if (anomalyFilter) {
                    dimmed = !c.events.some((e) => badgesById.has(e.id))
                  } else if (filterMatches) {
                    dimmed = !c.events.some((e) => filterMatches.has(e.id))
                  }
                  // In-chain event also gets a slim ring in the anchor's lane
                  // colour so operators can see the chain trail at a glance.
                  const anchorEvt = focusAnchorId ? eventsMapRef.current.get(focusAnchorId) : null
                  const inChain = focusChain && c.events.some((e) => focusChain.has(e.id))
                  const chainRingColor = anchorEvt
                    ? LANE_COLORS[toLane(anchorEvt.agentType, anchorEvt.data?.subtype as string | undefined, pluginTypes)]
                    : LANE_COLORS[c.lane]
                  // Badge overlay — only for single-event clusters (multi-dot
                  // clusters are already crowded; the operator can click into
                  // them and see badges in the popover row).
                  const badges = single ? badgesById.get(evt.id) : undefined
                  const badgeTitle = badges && badges.length
                    ? '\n' + badges.map((b) => `${b.icon} ${b.reason}`).join('\n')
                    : ''
                  // v0.7.7 U2: nudge subagent (Task-tool) events right by a
                  // few pixels so a burst of parallel subagent turns visibly
                  // hangs off its parent main-thread turn rather than
                  // clobbering it. Only applies to single-event dots
                  // (clusters already visually distinct via count label).
                  const indent = single ? subagentIndentPx(evt) : 0
                  return (
                    <div
                      key={c.key}
                      data-timeline-event
                      className="absolute cursor-pointer flex items-center justify-center"
                      style={{
                        left: c.x - hit / 2 + indent,
                        top: c.y - hit / 2,
                        width: hit,
                        height: hit,
                        zIndex: sel ? 10 : 2,
                        opacity: dimmed ? 0.15 : 1,
                        transition: 'opacity 120ms ease'
                      }}
                      title={single
                        ? `${formatTs(evt.timestamp, tz, projectTz, 'timeSec')} — ${eventTitle(evt)}${badgeTitle}${ioTitle(ioMark(evt), t)}`
                        : `${c.events.length} ${t('timeline.title')} · ${formatTs(c.events[0].timestamp, tz, projectTz, 'timeSec')}`}
                      onMouseEnter={() => { if (single) hoveredEventRef.current = evt }}
                      onMouseLeave={() => { if (single && hoveredEventRef.current === evt) hoveredEventRef.current = null }}
                      onClick={() => single ? setSelectedEvent(sel ? null : evt) : setCluster({ x: c.x, y: c.y, events: c.events })}
                    >
                      <div
                        className={dimmed ? 'flex items-center justify-center' : 'flex items-center justify-center transition-transform hover:scale-125'}
                        style={{
                          width: dot, height: dot,
                          borderRadius: single ? '50%' : 5,
                          backgroundColor: LANE_COLORS[c.lane],
                          border: single ? undefined : '1px solid rgba(0,0,0,0.45)',
                          boxShadow: sel
                            ? `0 0 0 2px #0a0a0a, 0 0 0 3px ${LANE_COLORS[c.lane]}, 0 0 12px ${LANE_COLORS[c.lane]}60`
                            : inChain
                              ? `0 0 0 1.5px ${chainRingColor}, 0 0 8px ${chainRingColor}80`
                              : `0 0 6px ${LANE_COLORS[c.lane]}40`
                        }}
                      >
                        {!single && <span style={{ fontSize: 9, fontWeight: 800, color: 'rgba(0,0,0,0.78)', lineHeight: 1 }}>{c.events.length}</span>}
                      </div>
                      {/* v0.9.6 (T3): I/O texture on single shell command_end
                          dots. A 3px notch = output exists on disk; amber =
                          nothing was captured (distinct from "printed
                          nothing", which gets no notch at all). Clusters are
                          skipped — the popup lists members individually. */}
                      {single && (() => {
                        const m = ioMark(evt)
                        if (!m.io && !m.fail) return null
                        return (
                          <>
                            {m.fail && (
                              <span
                                style={{
                                  position: 'absolute', width: dot + 5, height: dot + 5,
                                  borderRadius: '50%', border: '1.5px solid #ef4444',
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                            {m.io && (
                              <span
                                style={{
                                  position: 'absolute',
                                  left: hit / 2 + dot / 2 - 3, top: hit / 2 + dot / 2 - 3,
                                  width: 3, height: 3, borderRadius: '50%',
                                  background: IO_MARK_COLOR[m.io],
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                          </>
                        )
                      })()}
                      {/* Feature 3: single-badge bubble at top-right. Only the
                          first badge shows here to keep the dot readable; the
                          rest surface in the tooltip and in the detail panel. */}
                      {single && badges && badges.length > 0 && (
                        <span
                          className="absolute -top-0.5 -right-0.5 rounded-full bg-zinc-950/95 border border-amber-500/60 text-[8px] leading-none flex items-center justify-center pointer-events-none"
                          style={{ width: 12, height: 12 }}
                        >
                          {badges[0].icon}
                        </span>
                      )}
                    </div>
                  )
                })}
                {/* Cluster contents popover */}
                {cluster && (() => {
                  // Popover width + cap: cluster popovers used to render EVERY event
                  // in a burst (audit P2 — a 3000-event mitmproxy scan filled the
                  // list with 3000 <button>s). Cap at 50 with a "+N more" footer;
                  // operator can zoom in to see individually.
                  const POPUP_W = 240
                  const POPUP_MAX_H = 210
                  const MAX_ITEMS = 50
                  const capped = cluster.events.slice(0, MAX_ITEMS)
                  const overflow = cluster.events.length - capped.length
                  // Viewport-relative clamp: previous impl clamped only to TRACK_W,
                  // so a popover on a wide-zoom track near the right of the visible
                  // scroll port drew off-screen. Clamp against the visible window
                  // (scrollLeft + clientWidth) instead.
                  const el = scrollRef.current
                  const visLeft = el ? el.scrollLeft : 0
                  const visRight = el ? el.scrollLeft + el.clientWidth : TRACK_W
                  const rawLeft = cluster.x + 10
                  const left = Math.max(visLeft + 4, Math.min(rawLeft, visRight - POPUP_W - 4))
                  const top = cluster.y + 12 + POPUP_MAX_H > totalH
                    ? Math.max(0, cluster.y - POPUP_MAX_H - 4)
                    : cluster.y + 12
                  return (
                  <div className="absolute z-30" data-timeline-popup style={{ left, top, width: POPUP_W }}>
                    <div className="rounded-md border border-zinc-700 bg-zinc-900/95 shadow-xl max-h-[210px] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800 sticky top-0 bg-zinc-900/95">
                        <span className="text-xs text-zinc-400 font-mono">{cluster.events.length} {t('timeline.title')}</span>
                        <button className="text-zinc-500 hover:text-zinc-200 text-xs leading-none" onClick={() => setCluster(null)}>×</button>
                      </div>
                      {capped.map((evt) => (
                        <button
                          key={evt.id}
                          className="w-full text-left px-2 py-1 hover:bg-white/5 flex items-center gap-2"
                          onClick={() => {
                            setSelectedEvent(evt)
                            setCluster(null)
                            // Zoom based on cluster time span rather than a hardcoded 8×
                            // so a 500-event burst in 1s and a 5-event burst in 30min
                            // both split into distinct dots. Aim for CLUSTER_PX * count
                            // pixels across the cluster's span at the new zoom.
                            const evs = cluster.events
                            const first = evs[0].timestamp
                            const last = evs[evs.length - 1].timestamp
                            const spanMs = Math.max(1, last - first)
                            const spanRatio = spanMs / Math.max(1, timeSpan)
                            const neededTrackW = (evs.length + 1) * CLUSTER_PX / Math.max(spanRatio, 0.001)
                            const spanZoom = neededTrackW / BASE_TRACK_W
                            const targetZoom = Math.max(zoom, Math.min(6, spanZoom))
                            if (Math.abs(targetZoom - zoom) > 0.01) {
                              pendingCenterTs.current = evt.timestamp
                              setZoom(targetZoom)
                            } else {
                              const sc = scrollRef.current
                              if (sc) sc.scrollLeft = Math.max(0, Math.min(toX(displayTs(evt)) - sc.clientWidth / 2, TRACK_W - sc.clientWidth))
                            }
                          }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)] }} />
                          <span className="text-zinc-600 font-mono text-[11px] tabular-nums shrink-0">{formatTs(evt.timestamp, tz, projectTz, 'timeSec')}</span>
                          <span className="text-zinc-300 text-xs truncate">{eventTitle(evt)}</span>
                        </button>
                      ))}
                      {overflow > 0 && (
                        <div className="px-2 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 sticky bottom-0 bg-zinc-900/95">
                          {t('timeline.clusterMoreItems', { count: overflow })}
                        </div>
                      )}
                    </div>
                  </div>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* Event log — bottom panel. Sized in vh (was hardcoded 160/180 px)
            so the +1-step hint font from v0.6.56 doesn't push rows off the
            bottom, and so the panel scales with window height. Values chosen
            so the list shows ~5 rows at 900 px tall and ~8 at 1200 px. */}
        <div className="shrink-0 border-t border-zinc-800/60 bg-zinc-950/50" style={{ height: selectedEvent ? '18vh' : '22vh' }}>
          <div className="px-3 py-1.5 border-b border-zinc-800/40 flex items-center justify-between">
            <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">{t('timeline.title')}</span>
            <span className="text-xs text-zinc-600 font-mono tabular-nums">{recentEvents.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ height: `calc(${selectedEvent ? '18vh' : '22vh'} - 32px)` }}>
            {recentEvents.map((evt) => {
              const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)
              const isSel = selectedEvent?.id === evt.id
              return (
                <div
                  key={evt.id}
                  className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors text-[11px] border-b border-zinc-900/30 ${
                    isSel ? 'bg-zinc-800/50' : 'hover:bg-zinc-800/20'
                  }`}
                  onClick={() => setSelectedEvent(isSel ? null : evt)}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[lane] }} />
                  <span className="text-zinc-600 font-mono tabular-nums shrink-0 w-16">
                    {formatTs(evt.timestamp, tz, projectTz, 'timeSec')}
                  </span>
                  {showOperator && (
                    <span className="text-zinc-500 font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
                      {operatorLabel(evt.operatorId)}
                    </span>
                  )}
                  <span className="text-zinc-400 truncate">{eventTitle(evt)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Enhanced detail panel — height is drag-resizable; the handle at the
          top edge sets height in px (persisted to localStorage). Falling back
          to the CSS `max-h-[45vh]` when the operator hasn't dragged. */}
      {selectedEvent && (
        <>
          {/* Drag handle — 4px hit strip along the top edge; visual accent on hover. */}
          <div
            className="shrink-0 h-1 cursor-row-resize bg-zinc-800/50 hover:bg-red-500/40 transition-colors relative"
            title={t('timeline.resizeDetailPanel')}
            onMouseDown={(e) => {
              e.preventDefault()
              const currentH = detailPanelRef.current?.getBoundingClientRect().height ?? 320
              detailResizing.current = { startY: e.clientY, startH: currentH }
              document.body.classList.add('timeline-resizing')
            }}
            onDoubleClick={() => {
              // Double-click resets to default (CSS 45vh).
              setDetailPanelPx(null)
              try { localStorage.removeItem('redlog-timeline-detail-h') } catch { /* ignore */ }
            }}
          >
            <div className="absolute left-1/2 top-0 -translate-x-1/2 h-1 w-8 rounded bg-zinc-600/50 pointer-events-none" />
          </div>
        <div
          ref={detailPanelRef}
          className={`shrink-0 border-t border-zinc-700/50 px-4 py-3 bg-zinc-900/80 overflow-y-auto${detailPanelPx == null ? ' max-h-[45vh]' : ''}`}
          style={detailPanelPx == null ? undefined : { height: detailPanelPx }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined, pluginTypes)] }} />
              <span className="text-[11px] font-mono font-semibold uppercase tracking-wider" style={{ color: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined, pluginTypes)] }}>
                {selectedEvent.agentType}
              </span>
              <span className="text-xs font-mono text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800/60" title={selectedEvent.operatorId}>
                {operatorLabel(selectedEvent.operatorId)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
                const fields = fieldsWithRedactions(spans)
                if (fields.length === 0) return null
                const revealed = revealedEvents.has(selectedEvent.id)
                return (
                  <button
                    onClick={async () => {
                      const next = new Set(revealedEvents)
                      if (revealed) {
                        next.delete(selectedEvent.id)
                      } else {
                        next.add(selectedEvent.id)
                        // Log the reveal — additive event, never blocks the UI.
                        try { await window.redlog.events.logSecretRevealed(selectedEvent.id, fields) } catch { /* ignore */ }
                      }
                      setRevealedEvents(next)
                    }}
                    title={revealed ? t('timeline.reveal.hideHint') : t('timeline.reveal.showHint', { fields: fields.join(', ') })}
                    className={`text-xs px-2 py-0.5 rounded transition-colors ${revealed ? 'bg-amber-700/60 text-amber-100' : 'bg-amber-900/40 text-amber-400 hover:bg-amber-900/60'}`}
                  >
                    {revealed ? t('timeline.reveal.hide') : t('timeline.reveal.show', { n: spans?.length ?? 0 })}
                  </button>
                )
              })()}
              {/* v0.7.7 U3: "Open sidecar" for agent.transcript_snapshot
                  events. `snapshot_path` is inside the project's
                  agent-transcripts/ dir; data.revealPath opens it via the
                  OS file browser (`shell.openPath` in main). Pre-v0.7.7
                  the sidecar was only reachable if the operator dug it out
                  of the raw JSON view — one click now. */}
              {selectedEvent.agentType === 'agent'
                && (selectedEvent.data?.subtype as string | undefined) === 'transcript_snapshot'
                && typeof selectedEvent.data?.snapshot_path === 'string' && (
                <button
                  onClick={async () => {
                    const p = selectedEvent.data?.snapshot_path as string
                    const ok = await window.redlog.data?.revealPath?.(p)
                    if (!ok) toast(t('timeline.openSidecarFailed'), 'error')
                  }}
                  className="text-xs px-2 py-0.5 rounded bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors"
                  title={t('timeline.openSidecarHint')}
                >
                  {t('timeline.openSidecar')}
                </button>
              )}
              <button
                onClick={() => setShowJson(!showJson)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${showJson ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
              >
                {t('timeline.fullData')}
              </button>
              <button
                onClick={copyEventJson}
                className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {t('timeline.copyJson')}
              </button>
              <button
                onClick={() => { setSelectedEvent(null); setShowJson(false) }}
                className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors ml-1"
              >
                ✕
              </button>
              <span className="text-xs text-zinc-600 font-mono tabular-nums">{formatTs(selectedEvent.timestamp, tz, projectTz, 'full')}</span>
            </div>
          </div>
          <p className="text-[12px] text-zinc-300 mt-1.5 font-mono leading-relaxed">{eventTitle(selectedEvent)}</p>
          {/* v0.6.89.5 feature 3: full stacked-row of integrity badges next
              to the title so the operator sees every flag at once (the dot
              overlay only shows the first). Empty when the event has none. */}
          {(() => {
            const badges = badgesById.get(selectedEvent.id)
            if (!badges || badges.length === 0) return null
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {badges.map((b) => (
                  <span
                    key={b.key}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 font-mono"
                    title={b.reason}
                  >
                    {b.icon} {b.reason}
                  </span>
                ))}
              </div>
            )
          })()}
          {/* v0.6.89.5 feature 1: `_causes` visualisation. Chips look up the
              cause in the in-memory events map; a click sets that event as
              the new selection and scrolls the track to centre it. A cause
              id not found in the map is a "chain broken" symptom — the T6
              case from the design grill — and gets a red chip so the
              operator can't miss it. */}
          {(() => {
            const causes = (selectedEvent.data as { _causes?: unknown } | undefined)?._causes
            if (!Array.isArray(causes) || causes.length === 0) return null
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-zinc-500 font-mono">
                  {t('timeline.detail.causedBy')}
                </span>
                {(causes as unknown[]).filter((c): c is string => typeof c === 'string').map((cid) => {
                  const cev = eventsMapRef.current.get(cid)
                  if (!cev) {
                    return (
                      <span
                        key={cid}
                        className="text-[11px] px-1.5 py-0.5 rounded border border-red-500/50 bg-red-500/15 text-red-300 font-mono"
                        title={cid}
                      >
                        {t('timeline.detail.causeNotFound', { id: cid.slice(0, 8) })}
                      </span>
                    )
                  }
                  const clane = toLane(cev.agentType, cev.data?.subtype as string | undefined, pluginTypes)
                  const cc = LANE_COLORS[clane]
                  return (
                    <button
                      key={cid}
                      onClick={() => { setSelectedEvent(cev); scrollToEvent(cev) }}
                      className="text-[11px] px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                      style={{ color: cc, backgroundColor: `${cc}18`, border: `1px solid ${cc}40` }}
                      title={eventTitle(cev)}
                    >
                      ◂ {eventTitle(cev)}
                    </button>
                  )
                })}
              </div>
            )
          })()}
          {/* Effects (reverse map). Capped at 20 chips; overflow footer says
              how many more without rendering thousands of buttons. */}
          {(() => {
            const eff = effectsById.get(selectedEvent.id)
            if (!eff || eff.length === 0) return null
            const CAP = 20
            const shown = eff.slice(0, CAP)
            const more = eff.length - shown.length
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-zinc-500 font-mono">
                  {t('timeline.detail.effects', { count: eff.length })}
                </span>
                {shown.map((eid) => {
                  const ev = eventsMapRef.current.get(eid)
                  if (!ev) return null
                  const elane = toLane(ev.agentType, ev.data?.subtype as string | undefined, pluginTypes)
                  const ec = LANE_COLORS[elane]
                  return (
                    <button
                      key={eid}
                      onClick={() => { setSelectedEvent(ev); scrollToEvent(ev) }}
                      className="text-[11px] px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                      style={{ color: ec, backgroundColor: `${ec}18`, border: `1px solid ${ec}40` }}
                      title={eventTitle(ev)}
                    >
                      ▸ {eventTitle(ev)}
                    </button>
                  )
                })}
                {more > 0 && (
                  <span className="text-[11px] text-zinc-500 font-mono">
                    {t('timeline.detail.effectsMore', { count: more })}
                  </span>
                )}
              </div>
            )
          })()}
          {/* Focus-chain hint bubble (feature 2) — small nudge shown on the
              currently-selected event's detail panel when focus mode is OFF.
              Suppressed entirely once the operator is already in focus mode
              so it doesn't add noise. */}
          {!focusChain && (
            <p className="mt-1 text-[10px] text-zinc-600 font-mono">
              {t('timeline.focusChain.enterHint')}
            </p>
          )}
          {selectedEvent.targetId && (
            <p className="text-xs text-zinc-500 mt-1 font-mono">{t('timeline.target', { target: selectedEvent.targetId })}</p>
          )}
          {/* v0.6.89: structured stdout/stderr + metadata split for shell
              command_end. Falls back to the legacy single-`output` block if
              stdout/stderr are unset (older captures, or the standard
              preexec hook which doesn't split streams). */}
          {selectedEvent.agentType === 'shell'
            && selectedEvent.data?.subtype === 'command_end'
            && (
              <CommandEndDetail data={selectedEvent.data as Record<string, unknown>} />
            )}
          {/* v0.9.2 U1: agent-turn detail. Body text (user_message /
              assistant_message / thinking) shown open by default via
              CollapsibleStream so the operator sees the prompt/response
              on click without another expand. tool_call renders the
              parsed input JSON; tool_result its output stream. */}
          {selectedEvent.agentType === 'agent' && (
            <AgentTurnDetail data={selectedEvent.data as Record<string, unknown>} />
          )}
          {/* Replay this command: only for shell.command_end from a builtin
              terminal — pulls the stdout window out of the session's .cast
              file instead of storing it in the chain. */}
          {selectedEvent.agentType === 'shell'
            && selectedEvent.data?.subtype === 'command_end'
            && selectedEvent.data?.source === 'builtin-terminal'
            && (
              <ReplayCommand eventId={selectedEvent.id} mode="command" />
            )}
          {/* Session-level replay: for session_start / session_end, replays
              the ENTIRE pty session. Critical when the operator ssh'd into
              a remote host — command_end only shows the local `ssh` line;
              session replay shows every keystroke and screen after that. */}
          {selectedEvent.agentType === 'shell'
            && (selectedEvent.data?.subtype === 'session_start' || selectedEvent.data?.subtype === 'session_end')
            && selectedEvent.data?.source === 'builtin-terminal'
            && (
              <ReplayCommand eventId={selectedEvent.id} mode="session" />
            )}
          {showJson && (() => {
            const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
            const revealed = revealedEvents.has(selectedEvent.id)
            // Mask string fields that have redaction spans unless the reviewer
            // opted into reveal. copyJson still copies the RAW event by design —
            // an operator investigating on their own machine needs the raw
            // bytes; the mask is UX, not the security boundary (that's Layer 4).
            const shown = revealed ? selectedEvent.data : maskEventData(selectedEvent.data ?? {}, spans)
            return (
              <pre className="mt-2 p-3 bg-zinc-950 rounded border border-zinc-800 text-xs text-zinc-400 font-mono overflow-x-auto leading-relaxed max-h-[120px] overflow-y-auto">
                {JSON.stringify(shown, null, 2)}
              </pre>
            )
          })()}
        </div>
        </>
      )}
    </div>
  )
}

// v0.6.89: human-readable byte size. Deliberately tiny — no third-party
// formatter for this. 1 KB = 1024 B (chosen so we don't disagree with `wc -c`
// output when the operator eyeballs numbers).
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Structured detail body for a shell command_end event. Renders separate
// stdout / stderr collapsible sections when the wrapper populated them,
// falls back to a "mixed" section for the legacy `output` field, and
// finishes with a compact key=value metadata grid.
function CommandEndDetail({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const hasStdout = typeof data.stdout === 'string'
  const hasStderr = typeof data.stderr === 'string'
  const hasLegacyOutput = !hasStdout && !hasStderr && typeof data.output === 'string'
  return (
    <div className="mt-2 space-y-1.5">
      {hasStdout && (
        <CollapsibleStream
          label={t('timeline.detail.stdout')}
          content={data.stdout as string}
          bytes={typeof data.stdout_bytes === 'number' ? data.stdout_bytes : undefined}
          truncated={data.stdout_truncated === true}
          accent="emerald"
          startOpen
        />
      )}
      {hasStderr && (
        <CollapsibleStream
          label={t('timeline.detail.stderr')}
          content={data.stderr as string}
          bytes={typeof data.stderr_bytes === 'number' ? data.stderr_bytes : undefined}
          truncated={data.stderr_truncated === true}
          accent="amber"
          startOpen={((data.stderr as string).length ?? 0) > 0}
        />
      )}
      {hasLegacyOutput && (
        <CollapsibleStream
          label={t('timeline.detail.stdoutMixed')}
          content={data.output as string}
          accent="zinc"
          startOpen
        />
      )}
      {/* v0.9.6 (T2/T3): say what happened to this command's output. Before
          this the panel showed exit code and duration and nothing else, so
          "produced no output" and "we never captured the output" looked
          identical — the same failure mode `recording_paused` exists to avoid
          for timeline gaps. Three states:
            · bytes on disk  → size + the replay control below
            · builtin term, nothing captured → say so explicitly
            · external shell → say output is not captured on this path, and
              name the wrapper that does capture it */}
      {!hasStdout && !hasStderr && !hasLegacyOutput && (
        <IoAbsenceNote
          builtin={data.source === 'builtin-terminal'}
          io={data.io as Record<string, unknown> | undefined}
        />
      )}
      <MetadataGrid
        entries={[
          ['exit_code', data.exit_code],
          ['duration_sec', data.duration_sec],
          ['cwd', data.cwd],
          ['pid', data.pid],
          ['terminal_id', data.terminalId ?? data.terminal_id],
          ['source', data.source],
          ['captured_by', data.captured_by]
        ]}
      />
    </div>
  )
}

/** v0.9.6 (T2): explains the absence — or the on-disk location — of a shell
 *  command's output, so an empty panel is never ambiguous. */
function IoAbsenceNote({ builtin, io }: { builtin: boolean; io?: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const len = typeof io?.len === 'number' ? (io.len as number) : null
  const bracketed = len !== null && !io?.unbracketed

  // Bytes exist on disk: the replay control below this renders them. Say how
  // much up front so the operator knows whether it's worth expanding.
  if (bracketed && len > 0) {
    // `len` is the cast span, not the output size — it includes the shell's
    // echo of the command line and the JSON framing of each write. Label it
    // as what it is; the real output byte count appears once the replay
    // below is expanded and the range has actually been read.
    return (
      <p className="text-[11px] text-emerald-400/80 font-mono px-2 py-1 rounded border border-emerald-600/30 bg-emerald-900/10">
        {t('timeline.detail.ioOnDisk', { size: formatBytes(len) })}
      </p>
    )
  }
  if (bracketed && len === 0) {
    return (
      <p className="text-[11px] text-zinc-500 font-mono px-2 py-1 rounded border border-zinc-800/60 bg-zinc-950/40">
        {t('timeline.detail.ioNone')}
      </p>
    )
  }
  return (
    <p className="text-[11px] text-amber-400/80 font-mono px-2 py-1 rounded border border-amber-600/30 bg-amber-900/10">
      {t(builtin ? 'timeline.detail.ioUnbracketed' : 'timeline.detail.ioNotCaptured')}
    </p>
  )
}

/** v0.9.2 U1: renders the payload of one `agent.*` event in the detail
 *  panel. Reuses CollapsibleStream + MetadataGrid so operators get the
 *  same expand/copy affordances they already know from shell events. */
function AgentTurnDetail({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const subtype = String(data.subtype ?? '')
  const isMessage = subtype === 'user_message' || subtype === 'assistant_message'
  const isThinking = subtype === 'thinking'
  const isToolCall = subtype === 'tool_call'
  const isToolResult = subtype === 'tool_result'

  // Message body: user_message / assistant_message emit `full` (up to 100KB
  // cap in tailer-host; `truncated:true` when hit) + `full_length` (the
  // pre-truncation size). Fall back to `preview` when `full` is absent
  // (compact_summary is preview-less post v0.8.0.1 F1, but other adapters
  // may emit preview-only).
  const bodyText = typeof data.full === 'string'
    ? (data.full as string)
    : (typeof data.preview === 'string' ? (data.preview as string) : '')
  const bodyBytes = typeof data.full_length === 'number' ? (data.full_length as number) : bodyText.length
  const bodyTruncated = data.truncated === true

  // Tool_call: `tool_input` is either the parsed object OR a shape like
  // {_truncated:true, keys:[...]} when the raw JSON was > 100KB.
  const toolInput = data.tool_input as Record<string, unknown> | undefined
  const toolInputStr = toolInput ? safePretty(toolInput) : ''

  // Tool_result: output is a string (capped at 100KB) with output_length
  // holding the pre-truncation size.
  const outputText = typeof data.output === 'string' ? (data.output as string) : ''
  const outputBytes = typeof data.output_length === 'number' ? (data.output_length as number) : outputText.length

  return (
    <div className="mt-2 space-y-1.5">
      {(isMessage || isThinking) && bodyText.length > 0 && (
        <CollapsibleStream
          label={t(isThinking ? 'timeline.detail.agentThinking' : subtype === 'user_message' ? 'timeline.detail.agentUser' : 'timeline.detail.agentAssistant')}
          content={bodyText}
          bytes={bodyBytes}
          truncated={bodyTruncated}
          accent={subtype === 'user_message' ? 'emerald' : isThinking ? 'zinc' : 'amber'}
          startOpen
        />
      )}
      {isToolCall && (
        <CollapsibleStream
          label={t('timeline.detail.agentToolInput', { name: String(data.tool_name ?? 'tool') })}
          content={toolInputStr}
          accent="zinc"
          startOpen
        />
      )}
      {isToolResult && outputText.length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.agentToolOutput')}
          content={outputText}
          bytes={outputBytes}
          truncated={data.truncated === true}
          accent="emerald"
          startOpen
        />
      )}
      <MetadataGrid
        entries={[
          ['agent', data.agent],
          ['session_id', data.session_id],
          ['model', data.model],
          ['tool_use_id', data.tool_use_id],
          ['transcript_uuid', data.transcript_uuid],
          ['usage_tokens_in', data.usage_tokens_in],
          ['usage_tokens_out', data.usage_tokens_out],
          ['post_compact', data.post_compact === true ? 'true' : undefined],
          ['is_sidechain', data.is_sidechain === true ? 'true' : undefined]
        ]}
      />
    </div>
  )
}

function safePretty(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const STREAM_ACCENTS: Record<'emerald' | 'amber' | 'zinc', { label: string; bar: string; bg: string; badge: string }> = {
  emerald: { label: 'text-emerald-400', bar: 'border-emerald-600/40', bg: 'bg-emerald-900/10', badge: 'text-emerald-300 bg-emerald-900/30' },
  amber:   { label: 'text-amber-400',   bar: 'border-amber-600/40',   bg: 'bg-amber-900/10',   badge: 'text-amber-300 bg-amber-900/30' },
  zinc:    { label: 'text-zinc-300',    bar: 'border-zinc-700/60',    bg: 'bg-zinc-900/40',    badge: 'text-zinc-300 bg-zinc-800/60' }
}

// Inline preview cap. Anything larger than this is rendered as head-4KB
// + a "Copy full" button that puts the entire raw string on the clipboard.
const INLINE_PREVIEW_BYTES = 4096

function CollapsibleStream({
  label,
  content,
  bytes,
  truncated,
  accent,
  startOpen
}: {
  label: string
  content: string
  bytes?: number
  truncated?: boolean
  accent: 'emerald' | 'amber' | 'zinc'
  startOpen?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(!!startOpen)
  const [copied, setCopied] = useState(false)
  const acc = STREAM_ACCENTS[accent]
  // Prefer the explicit bytes field (the true, pre-truncation size); fall
  // back to string length when the wrapper didn't stamp it (e.g. legacy
  // `output` field).
  const shownBytes = typeof bytes === 'number' ? bytes : content.length
  const isLarge = content.length > INLINE_PREVIEW_BYTES
  const preview = isLarge ? content.slice(0, INLINE_PREVIEW_BYTES) : content
  const copyFull = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(t('toast.copied'), 'success')
    } catch { /* ignore */ }
  }
  return (
    <div className={`border ${acc.bar} rounded ${acc.bg}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left"
      >
        <span className="text-[10px] text-zinc-500 font-mono w-3">{open ? '▼' : '▶'}</span>
        <span className={`text-[11px] font-mono font-semibold uppercase tracking-wider ${acc.label}`}>{label}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${acc.badge}`}>
          {formatBytes(shownBytes)}
        </span>
        {truncated && (
          <span className="text-[10px] font-mono text-amber-400" title={t('timeline.detail.truncatedHint')}>
            {t('timeline.detail.truncated')}
          </span>
        )}
        {isLarge && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); void copyFull() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void copyFull() } }}
            className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 cursor-pointer"
          >
            {copied ? t('timeline.detail.copied') : t('timeline.detail.copyFull')}
          </span>
        )}
      </button>
      {open && content.length > 0 && (
        <pre className="mx-2 mb-2 p-2 bg-zinc-950 rounded border border-zinc-800/60 text-xs text-zinc-300 font-mono max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
          {preview}
          {isLarge && (
            <span className="block mt-2 text-[10px] text-zinc-500">
              {t('timeline.detail.previewCut', { shown: formatBytes(preview.length), total: formatBytes(shownBytes) })}
            </span>
          )}
        </pre>
      )}
      {open && content.length === 0 && (
        <p className="mx-2 mb-2 px-2 py-1 text-[11px] text-zinc-600 font-mono italic">{t('timeline.detail.empty')}</p>
      )}
    </div>
  )
}

function MetadataGrid({ entries }: { entries: Array<[string, unknown]> }): JSX.Element {
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (rows.length === 0) return <></>
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-zinc-500">{k}</span>
            <span className="text-zinc-300 break-all">{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Pulled from the session's asciinema .cast on disk — not from the event
// row. Rendering here keeps the chain event clean (command + exit + duration
// only) while still letting the operator see what actually printed.
function ReplayCommand({ eventId, mode = 'command' }: { eventId: string; mode?: 'command' | 'session' }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [events, setEvents] = useState<Array<[number, 'o', string]> | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const fn = mode === 'session'
        ? window.redlog.terminal.replaySession
        : window.redlog.terminal.replay
      const r = await fn?.(eventId)
      if (!r) { setError('unsupported'); return }
      if (!r.ok) { setError(r.error ?? 'failed'); return }
      setText(r.text ?? '')
      // Only replaySession exposes the frame array today. Fall back to text
      // when events aren't there (e.g. command replay), so the pre-tag path
      // still works.
      const evs = (r as { events?: Array<[number, 'o', string]> }).events
      if (evs && evs.length > 0) setEvents(evs)
      setTruncated(Boolean((r as { truncated?: boolean }).truncated))
      setExpanded(true)
    } finally {
      setLoading(false)
    }
  }
  const btnLabel = mode === 'session' ? 'timeline.replay.sessionButton' : 'timeline.replay.button'
  if (!expanded) {
    return (
      <button
        onClick={load}
        disabled={loading}
        className="mt-1.5 text-xs px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40 disabled:opacity-50"
      >{loading ? t('timeline.replay.loading') : t(btnLabel)}</button>
    )
  }
  if (error) return <p className="mt-1.5 text-xs text-red-400">{t('timeline.replay.failed', { error })}</p>
  // Session replays get the full player (xterm + scrubber + speed). If the
  // slice happened to be empty of frames — legacy casts, empty session — we
  // still fall through to the pre so the operator sees *something*.
  if (mode === 'session' && events && events.length > 0) {
    return <SessionReplayPlayer events={events} truncated={truncated} />
  }
  const heightCls = mode === 'session' ? 'max-h-[400px]' : 'max-h-[200px]'
  return (
    <pre className={`mt-1.5 p-2 bg-zinc-950 rounded border border-zinc-800 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed ${heightCls} overflow-y-auto whitespace-pre-wrap`}>
      {text || t('timeline.replay.empty')}
    </pre>
  )
}

function fmtMMSS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

const SPEED_OPTIONS = [0.5, 1, 2, 4] as const

// Frame-accurate asciinema player for a whole session's .cast slice. Feeds
// bytes into a live xterm.js instance so ANSI escapes render exactly the way
// they did in the original pty. Seeks by resetting the terminal and
// fast-replaying every frame up to the target — clean, and cheap enough for
// the ~50MB cast cap enforced upstream.
function SessionReplayPlayer({ events, truncated }: { events: Array<[number, 'o', string]>; truncated: boolean }): JSX.Element {
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // idx: the next event index to emit. Kept in a ref so the scheduler
  // closure can advance it without going through React state (which would
  // trigger a re-render per frame).
  const idxRef = useRef(0)
  // Absolute cast time (ms) we're "at" — advances as frames play. Ref for
  // the scheduler; mirrored into state for the UI (scrubber + timestamp).
  const posRef = useRef(0)
  const speedRef = useRef(1)
  const playingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const [posMs, setPosMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const totalMs = Math.max(1, Math.round((events[events.length - 1]?.[0] ?? 0) * 1000))

  // Mount xterm once. Sized to the container width; falls back gracefully
  // when FitAddon has no dims yet (React 18 StrictMode double-mount).
  useEffect(() => {
    if (!wrapRef.current) return
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: { background: '#09090b', foreground: '#e4e4e7' },
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrapRef.current)
    try { fit.fit() } catch { /* container not sized yet */ }
    termRef.current = term
    fitRef.current = fit
    // Draw frame 0 (usually empty) so the terminal shows something.
    return () => {
      if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refit on container resize (detail panel width can change).
  useEffect(() => {
    if (!wrapRef.current || !fitRef.current) return
    const ro = new ResizeObserver(() => { try { fitRef.current?.fit() } catch { /* ignore */ } })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  // Write every frame with cast-time <= targetMs into the terminal, starting
  // from a clean slate. Used by both initial mount and seek. O(N) in event
  // count; fine for the sizes we cap at.
  const seekTo = useCallback((targetMs: number) => {
    const term = termRef.current
    if (!term) return
    term.reset()
    let i = 0
    for (; i < events.length; i++) {
      const [tSec, , data] = events[i]
      if (tSec * 1000 > targetMs) break
      term.write(data)
    }
    idxRef.current = i
    posRef.current = targetMs
    setPosMs(targetMs)
  }, [events])

  // Once xterm is mounted, seek to 0 so the terminal is definitely primed.
  useEffect(() => {
    seekTo(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Advance to the next frame with a real-time-scaled delay. The scheduler
  // reads from refs (idx/pos/speed/playing) so speed changes and pauses take
  // effect on the *next* frame — no need to tear down and rebuild timers.
  const scheduleNext = useCallback(() => {
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
    if (!playingRef.current) return
    const term = termRef.current
    if (!term) return
    if (idxRef.current >= events.length) {
      playingRef.current = false
      setPlaying(false)
      posRef.current = totalMs
      setPosMs(totalMs)
      return
    }
    const [tSec, , data] = events[idxRef.current]
    const evMs = tSec * 1000
    const wait = Math.max(0, evMs - posRef.current) / (speedRef.current || 1)
    // Cap wait so a long idle stretch (operator was afk for 20 minutes) doesn't
    // freeze the player. Anything longer than 3s / speed collapses to 3s / speed
    // — you can still scrub past it, but auto-play doesn't leave you staring at
    // a blank terminal.
    const capped = Math.min(wait, 3000 / (speedRef.current || 1))
    timerRef.current = window.setTimeout(() => {
      term.write(data)
      idxRef.current += 1
      posRef.current = evMs
      setPosMs(evMs)
      scheduleNext()
    }, capped)
  }, [events, totalMs])

  const doPlay = useCallback(() => {
    if (posRef.current >= totalMs) {
      // At end — restart from 0. Same semantics as most players.
      seekTo(0)
    }
    playingRef.current = true
    setPlaying(true)
    scheduleNext()
  }, [scheduleNext, seekTo, totalMs])

  const doPause = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  const onSeek = useCallback((ms: number) => {
    const wasPlaying = playingRef.current
    doPause()
    seekTo(Math.max(0, Math.min(totalMs, ms)))
    if (wasPlaying) doPlay()
  }, [doPause, doPlay, seekTo, totalMs])

  const onSpeed = useCallback((v: number) => {
    speedRef.current = v
    setSpeed(v)
    // No teardown — the running timeout is honored, then the next scheduled
    // frame picks the new speed up.
  }, [])

  // Stop the timer on unmount.
  useEffect(() => () => {
    playingRef.current = false
    if (timerRef.current != null) clearTimeout(timerRef.current)
  }, [])

  return (
    <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div ref={wrapRef} className="h-[360px] w-full p-2" />
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900/70 px-2 py-1.5 text-xs">
        <button
          onClick={() => (playing ? doPause() : doPlay())}
          className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
          aria-label={playing ? t('timeline.replay.pause') : t('timeline.replay.play')}
        >{playing ? t('timeline.replay.pause') : t('timeline.replay.play')}</button>
        <button
          onClick={() => onSeek(posRef.current - 5000)}
          className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >{t('timeline.replay.stepBack')}</button>
        <button
          onClick={() => onSeek(posRef.current + 5000)}
          className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >{t('timeline.replay.stepForward')}</button>
        <input
          type="range"
          min={0}
          max={totalMs}
          step={100}
          value={posMs}
          aria-label={t('timeline.replay.seek')}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="flex-1 accent-cyan-500"
        />
        <span className="font-mono tabular-nums text-zinc-400 whitespace-nowrap">{fmtMMSS(posMs)} / {fmtMMSS(totalMs)}</span>
        <label className="flex items-center gap-1 text-zinc-500">
          <span>{t('timeline.replay.speed')}</span>
          <select
            value={speed}
            onChange={(e) => onSpeed(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </label>
      </div>
      {truncated && (
        <p className="px-2 py-1 text-[11px] text-amber-400 border-t border-zinc-800 bg-zinc-900/40">{t('timeline.replay.truncated')}</p>
      )}
    </div>
  )
}

