// Pure domain constants and utility functions for the Timeline panel.
// Pulled out of Timeline.tsx so they are testable in isolation and
// reusable by other modules (e.g. eventTitle, first-run strip).
// No React dependency — everything here is a type, a constant, or a
// referentially transparent function.

import { formatTime, formatTs, type TzMode } from './time'
import { compareMonotonicNs } from './eventOrder'

// ── Lane / band topology ────────────────────────────────────────────
// v0.6.92 W-project: added `browser` (CDP console) between scanner and dns,
// and `process` (spawn/exit) between scope and system so it doesn't dilute
// the top attack-narrative lanes.
export const LANES = ['shell', 'agent', 'http_navigation', 'scanner', 'browser', 'dns', 'pivot', 'screenshot', 'clipboard', 'file_transfer', 'credential_use', 'c2_checkin', 'marker', 'loot', 'cleanup', 'scope', 'process', 'system'] as const
export type LaneId = (typeof LANES)[number]

// Capture-group bands (docs/DESIGN-core-and-capture.md §6). Eighteen lanes is
// past reliable scanning; most engagements touch three or four. The bands are
// the same grouping the capture-readiness model uses (commands / traffic /
// artifacts) plus a signals band for the derived/alert lanes — so the timeline
// and the readiness card describe capture the same way. A band collapses to a
// single row whose dots keep their per-lane colour (so what happened is still
// legible), and expands to its member lanes. Every lane belongs to exactly one
// band; the order here is the row order.
export type BandId = 'commands' | 'traffic' | 'artifacts' | 'signals'
export const BANDS: ReadonlyArray<{ id: BandId; lanes: readonly LaneId[] }> = [
  { id: 'commands', lanes: ['shell', 'agent', 'process'] },
  { id: 'traffic', lanes: ['http_navigation', 'scanner', 'browser', 'dns', 'pivot', 'c2_checkin'] },
  { id: 'artifacts', lanes: ['screenshot', 'clipboard', 'file_transfer', 'loot'] },
  { id: 'signals', lanes: ['marker', 'scope', 'credential_use', 'cleanup', 'system'] }
]
export const BAND_OF: Record<LaneId, BandId> = Object.fromEntries(
  BANDS.flatMap((b) => b.lanes.map((l) => [l, b.id]))
) as Record<LaneId, BandId>
// Lanes in band order — replaces the raw LANES order for row layout so a
// band's members are contiguous.
export const LANES_BY_BAND: readonly LaneId[] = BANDS.flatMap((b) => b.lanes)

// Lanes with no built-in producer — populated only by external agents
// (custom MCP tools, third-party plugins) posting to /api/events. Showing
// them as plain "empty" is misleading; the chip tooltip says so explicitly.
// v0.6.92: `dns` now has a built-in producer (mitmproxy DNS mode), so it's
// removed from this set. `credential_use` and `c2_checkin` remain external-only.
export const EXTERNAL_ONLY_LANES: Set<LaneId> = new Set(['credential_use', 'c2_checkin'])

// v0.14.4 (UIUX-STANDARD §1): hue is now reserved for status
// (safe / unknown / danger); lanes separate by label and vertical position,
// which is what an operator actually reads them by. Every lane is `lane`
// (#6e6e78) and the palette is a function, not a table.
const LANE_COLOR = '#6e6e78'
export const LANE_COLORS: Record<LaneId, string> = Object.fromEntries(
  LANES.map((id) => [id, LANE_COLOR])
) as Record<LaneId, string>

// ── Types ────────────────────────────────────────────────────────────

export interface PluginEventType {
  agentType: string
  label: string
  lane?: string
  color?: string
  icon?: string
  pluginId: string
}

/** v0.9.6 (T3): what the track should say about a shell command's output.
 *  `fail` outlines the dot when the command exited non-zero; `io` decides
 *  the small notch on its lower-right. */
export type IoMark = 'recorded' | 'uncaptured' | null

export type DotShape = 'circle' | 'diamond' | 'ring'

// v0.6.89.5: chain-integrity + evidence-integrity badges.
export interface EventBadge {
  icon: string
  /** A literal reason, for the twenty badges that predate localisation. */
  reason?: string
  /** An i18n key, for new badges. Rendered through `t` at the two call sites. */
  reasonKey?: string
  key: string
}

export const IO_MARK_COLOR: Record<Exclude<IoMark, null>, string> = {
  recorded: '#e5e5e5',
  uncaptured: '#f59e0b'
}

// ── Pure functions ───────────────────────────────────────────────────

// v0.6.87 C1: markers created by right-clicking Timeline background carry
// a `data.atTimestamp` that overrides their chain wall-clock for rendering
// purposes only. This keeps the chain honest (the row's `timestamp` still
// records when it was actually created) while letting the marker appear on
// the Timeline where the operator meant to drop it. Non-marker events
// always render at their true timestamp.
export function displayTs(e: RedLogEvent): number {
  const at = e.data?.atTimestamp
  if (e.agentType === 'marker' && typeof at === 'number' && at > 0) return at
  return e.timestamp
}

/** v0.9.2 U1: pick the first string-valued arg from a tool_call input for
 *  the lane one-liner. Falls back to key list when the values are all
 *  objects/arrays. Cap prevents a giant path from dominating the row. */
export function firstStringArg(input: Record<string, unknown>, cap: number): string {
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

export function toLane(agentType: string, subtype?: string, pluginTypes?: PluginEventType[]): LaneId {
  // Scope violations are stored under agent_type='system' for historical reasons
  // (historical: a since-removed webhook filter watched 'system'). Route them into their own
  // lane at render time so they don't drown in the system-lane housekeeping.
  if (agentType === 'system' && (subtype === 'scope_violation' || subtype === 'scope_recomputed' || subtype === 'scope_cleared')) return 'scope'
  if (LANES.includes(agentType as LaneId)) return agentType as LaneId
  // Plugin-registered event type maps into whichever built-in lane the plugin
  // declared (its `lane` field). Falls back to `system` when the plugin didn't
  // supply one or the declared lane isn't valid.
  const pluginDef = pluginTypes?.find((p) => p.agentType === agentType)
  if (pluginDef?.lane && LANES.includes(pluginDef.lane as LaneId)) return pluginDef.lane as LaneId
  return 'system'
}

// Comparator: primary sort by wall-clock, tiebreak by monotonic_ns when
// two events share the same ms. monotonic_ns comes from Node's process.hrtime
// (or its equivalent) and is captured as a string of digits — compare as
// BigInt so we don't collapse 40-digit values into Number precision.
export function eventCompare(a: RedLogEvent, b: RedLogEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const mono = compareMonotonicNs(a.monotonicNs, b.monotonicNs)
  if (mono !== 0) return mono
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// v0.6.95 P1-12: keep the events array sorted incrementally rather than
// re-sorting on every batch. Full sort of 100k events is O(n log n) ~ 1.7M
// compares per flush — at 200 evt/s that's a heap-thrash. Since events almost
// always arrive in `created_at` order, the common case is "append to end",
// which we detect with a cheap last-element check and skip the search entirely.
export function binarySearchInsert(sorted: RedLogEvent[], evt: RedLogEvent): void {
  const n = sorted.length
  if (n === 0) { sorted.push(evt); return }
  if (eventCompare(evt, sorted[n - 1]) >= 0) { sorted.push(evt); return }
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (eventCompare(sorted[mid], evt) < 0) lo = mid + 1
    else hi = mid
  }
  sorted.splice(lo, 0, evt)
}

export function formatTimeLabel(date: Date): string {
  return formatTime(date.getTime())
}

// v0.6.91 S7: timezone-aware formatter.
/** v0.11.4 (AUDIT V6): time-only ticks are ambiguous across midnight. Prefix
 *  the date on the first tick and on any tick that starts a new day. */
export function axisLabel(
  ts: number, i: number, ticks: number[], span: number, tz: TzMode, projectTz: string | null
): string {
  const time = formatTs(ts, tz, projectTz, 'time')
  if (span < 24 * 3600_000) return time
  const dayOf = (ms: number): string => {
    const d = new Date(ms)
    return tz === 'utc' ? d.toISOString().slice(0, 10) : d.toDateString()
  }
  if (i > 0 && dayOf(ticks[i - 1]) === dayOf(ts)) return time
  const d = new Date(ts)
  const date = tz === 'utc'
    ? d.toISOString().slice(5, 10)
    : `${d.getMonth() + 1}/${d.getDate()}`
  return `${date} ${time}`
}

export function formatBehind(ms: number): string {
  if (ms < 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `24h+`
}

export function ioMark(e: RedLogEvent): { io: IoMark; fail: boolean } {
  if (e.agentType !== 'shell' || e.data?.subtype !== 'command_end') return { io: null, fail: false }
  const fail = Number(e.data?.exit_code ?? 0) !== 0
  const inline = typeof e.data?.stdout === 'string' || typeof e.data?.stderr === 'string' || typeof e.data?.output === 'string'
  if (inline) {
    const n = String(e.data?.stdout ?? '').length + String(e.data?.stderr ?? '').length + String(e.data?.output ?? '').length
    return { io: n > 0 ? 'recorded' : null, fail }
  }
  const io = e.data?.io as { len?: number; unbracketed?: boolean } | undefined
  if (io && typeof io.len === 'number' && !io.unbracketed && io.len > 0) {
    return { io: 'recorded', fail }
  }
  return { io: 'uncaptured', fail }
}

/** v0.11.4 (AUDIT V3): severity and scope violations were invisible on the
 *  track. Encoded as SHAPE rather than more colour. */
export function dotShape(e: RedLogEvent, effectiveSeverity?: string): { shape: DotShape; scale: number } {
  const sub = e.data?.subtype as string | undefined
  if (e.agentType === 'system' && sub === 'scope_violation') return { shape: 'diamond', scale: 1.25 }
  if (e.agentType === 'marker') {
    if (sub === 'amended') return { shape: 'circle', scale: 1 }
    const sev = String(effectiveSeverity ?? e.data?.severity ?? 'info')
    if (sev === 'critical') return { shape: 'ring', scale: 1.5 }
    if (sev === 'important') return { shape: 'circle', scale: 1.25 }
  }
  return { shape: 'circle', scale: 1 }
}

export function shapeTitle(e: RedLogEvent, t: (k: string) => string, effectiveSeverity?: string): string {
  const sub = e.data?.subtype as string | undefined
  if (e.agentType === 'system' && sub === 'scope_violation') return ` · ${t('timeline.shape.scopeViolation')}`
  if (e.agentType === 'marker') {
    if (sub === 'amended') return ''
    const sev = String(effectiveSeverity ?? e.data?.severity ?? 'info')
    if (sev === 'critical' || sev === 'important') return ` · ${t(`marker.severity.${sev}`)}`
  }
  return ''
}

export function ioTitle(m: { io: IoMark; fail: boolean }, t: (k: string) => string): string {
  const parts: string[] = []
  if (m.fail) parts.push(t('timeline.io.failed'))
  if (m.io === 'recorded') parts.push(t('timeline.io.recorded'))
  else if (m.io === 'uncaptured') parts.push(t('timeline.io.uncaptured'))
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

export function computeBadges(
  evt: RedLogEvent,
  brokenAtId?: string | null,
  clearedViolations?: ReadonlySet<string>,
  supersededViolations?: ReadonlySet<string>
): EventBadge[] {
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
  if (evt.agentType === 'system' && (sub === 'screenshot_deleted' || sub === 'cast_pruned' || sub === 'screenshot_pruned' || sub === 'cast_evicted' || sub === 'screenshot_evicted')) {
    b.push({ icon: '🗑️', reason: `evidence removed (${sub})`, key: 'evidence' })
  }
  if (evt.agentType === 'system' && sub === 'anchor_failed') {
    b.push({ icon: '⚓✗', reason: 'OTS anchor failed', key: 'anchor' })
  }
  if (evt.agentType === 'system' && sub === 'chain_sample_broken') {
    b.push({ icon: '⛓️‍💥', reason: 'the record does not join up here — something may be missing', key: 'sample-broken' })
  }
  if (brokenAtId && evt.id === brokenAtId) {
    b.push({ icon: '⛓️‍💥', reason: 'full-chain verify broke here', key: 'verify-broken' })
  }
  if (evt.agentType === 'agent' && d.is_sidechain === true) {
    b.push({ icon: '↪', reason: 'subagent (Task tool) turn — separate reasoning thread', key: 'sidechain' })
  }
  if (evt.agentType === 'system' && sub === 'scope_violation' && d.judged === 'retroactive') {
    b.push({ icon: '⟲', reasonKey: 'timeline.badge.retroactive', key: 'retro' })
  }
  if (evt.agentType === 'system' && sub === 'scope_violation'
      && (clearedViolations?.has(evt.id) || supersededViolations?.has(evt.id))) {
    b.push({ icon: '✓', reasonKey: 'timeline.badge.cleared', key: 'cleared' })
  }
  return b
}

/** v0.7.7 U2: horizontal indent for subagent turns on the Timeline. */
export function subagentIndentPx(evt: RedLogEvent): number {
  const d = (evt.data as Record<string, unknown> | undefined) ?? {}
  return evt.agentType === 'agent' && d.is_sidechain === true ? 12 : 0
}

// BFS walk of the causal graph anchored at `anchor`. Walks `_causes` upstream
// AND the reverse-effects map downstream, both bounded to depth 20.
export function walkFocusChain(
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
