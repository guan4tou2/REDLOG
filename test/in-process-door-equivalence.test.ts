// Spec 071 T037: the row is the same whichever way it is written.
//
// Thirty production call sites write a `system`, `marker` or `loot` row with the
// DB primitive `insertEvent(` and publish it by hand; T037 moves them to the
// door, `ingestEvent` / `ingest`. That is safe only if the stored row does not
// change. By reading, every pre-commit step of `ingest()` is a no-op for these
// three types (no causes, no enrichment, nothing for the redaction pass to
// read), so the row is the same and the door adds exactly one publish after
// the commit. This file is that claim as an observation.
//
// Each case below is a call site's real data literal and options, written twice
// into two fresh project databases — once with `insertEvent` as the site does
// today, once through the door with the options the migration will pass — and
// every column of both tables is compared, `data` byte for byte, `hash`,
// `prev_hash` and `signature` included. The ids, clocks and signature are
// fixed as in test/ingest-golden.test.ts so nothing differs by chance. A case
// that differs lists the exact fields in `differs`, with why.
//
// Not every site's write sits in a plain call:
//   - `ctx` runs the write under withEntrance(...), as the API route does for
//     the recording marker, anchor_failed, logged_tier_digest, sanitized and
//     loot from /api/loot/scan;
//   - `drive` reaches the write the way production does: ingest() of a shell
//     command whose after-commit step calls a stub detector / alert runtime,
//     which writes the loot or scope_violation row. ingest's own
//     withEntrance(DERIVED, ...) is then the ambient entrance, not one set here;
//   - `tx` is the scope recompute, three rows in one transaction.
//
// The sites that hand on a target's `target_via` (loot, a marker amendment)
// need `inheritsVia`; the negative cases show what is stored without it.
//
// Teardown closes the HTTP body index before the database and before the
// directory is removed (the Windows leg fails with EBUSY otherwise).

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import type { RedLogEvent } from '../src/core/db/events'
import type { TargetVia } from '../src/core/ingest/stamp'

const sqlite = requires('better-sqlite3')

// The API token lives under HOME; nothing here may touch the real one.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-eq-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

// Controlled from outside so each case can be given the same clock whichever
// side it runs on (see runSide).
const control = vi.hoisted(() => ({ ns: 0n, prefix: 0, n: 0 }))
vi.mock('../src/core/clock', async (actual) => {
  const real = await actual<typeof import('../src/core/clock')>()
  return { ...real, monotonicNs: () => String(control.ns += 1000n), getNtpOffsetMs: () => null }
})
vi.mock('../src/core/signing', async (actual) => {
  const real = await actual<typeof import('../src/core/signing')>()
  return { ...real, signEvent: (canonical: string, operator: string) => `sig:${operator}:${crypto.createHash('sha256').update(canonical).digest('hex')}` }
})

const ENG = 'eng-equiv'
const OP = 'op-equiv'
const T0 = Date.UTC(2026, 10, 15, 9, 0, 0)
const SRC_TIME = T0 + 5_000
const OCCURRED = T0 - 3_600_000

type Agent = 'system' | 'marker' | 'loot'
/** The hand-written publish beside the call today: none, plain, or with bypassPause. */
type TodayPublish = 'none' | 'plain' | 'bypass'

interface Step {
  agent: Agent
  data: Record<string, unknown>
  /** The options besides engagement and operator that the site passes to insertEvent. */
  opts?: { targetId?: string; targetVia?: TargetVia; occurredAt?: number; entrance?: 'LEGACY_API' }
  /** `omitted`: the site passes no engagement (insertEvent takes the open database's);
   *  the door is handed `engagementForWrite(undefined)`, which is the same id. */
  engagement?: 'omitted'
  operator?: string
  publish: TodayPublish
  /** What the migration passes besides what the site passes today. */
  later: { bypassPause?: true; inheritsVia?: true }
}

interface Case {
  name: string
  /** The spec's call-site number, #1 to #30. */
  site: number
  steps: Step[]
  ctx?: 'LEGACY_API' | 'DERIVED'
  paused?: true
  tx?: true
  drive?: 'loot' | 'scope'
  /** The exact fields that differ between the two ways, and why. */
  differs?: { fields: string[]; why: string }
}

const sys = (subtype: string, rest: Record<string, unknown> = {}): Record<string, unknown> => ({ subtype, ...rest })
const step = (agent: Agent, data: Record<string, unknown>, publish: TodayPublish, later: Step['later'] = {}, more: Partial<Step> = {}): Step =>
  ({ agent, data, publish, later, ...more })

// --- the data literals, as the sites build them --------------------------------

const recording = (subtype: string, source: string): Record<string, unknown> =>
  ({ subtype, description: subtype === 'recording_paused' ? 'Recording paused' : 'Recording resumed', source })

const hudMarker = (): Record<string, unknown> => ({
  title: 'HUD mark', notes: '', severity: 'info', category: 'custom', source_timestamp: SRC_TIME, source: 'hud-instant'
})

const configChanged = sys('config_changed', {
  changed: { 'network.offline': { from: false, to: true } },
  description: 'Config changed: network.offline'
})

const prune = (subtype: string, causes?: string[]): Record<string, unknown> => ({
  subtype, path: '/p/recordings/a.cast', bytes: 2048, ageDays: 31, description: 'pruned by retention policy (30d)',
  ...(causes ? { _causes: causes } : {})
})

const evicted = (subtype: string): Record<string, unknown> => ({
  subtype, count: 3, freed_bytes: 3072, total_bytes: 9000, budget_bytes: 6000, shortfall_bytes: 0,
  description: `Evicted 3 ${subtype.split('_')[0]} file(s) under disk pressure (freed 3072 bytes; in-scope ${subtype.split('_')[0]}s kept).`
})

const loggedDigest = sys('logged_tier_digest', {
  count: 12, sha256: 'ab'.repeat(32), oldest_at: T0 - 9000, newest_at: T0 - 1000, reason: 'export',
  description: `export: logged-tier snapshot — 12 row(s), sha256 ${'ab'.repeat(6)}…`
})

const lootRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  subtype: 'credential_detected',
  matches: [{ type: 'password', confidence: 'high', preview: 'password=hunter2' }],
  count: 1,
  source: 'curl http://10.9.9.9/login',
  _causes: ['cause-event-1'],
  ...extra
})

const scopeViolation = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  subtype: 'scope_violation', authority: 'fact', severity: 'critical', target: '10.1.1.1',
  action: 'curl http://10.1.1.1/admin', source: 'shell', distance: 'out_of_scope', _causes: ['cause-event-2'], ...extra
})

const amended = (): Record<string, unknown> => ({
  subtype: 'amended', markerId: 'marker-1', _causes: ['marker-1'], title: 'Corrected title', notes: 'corrected notes'
})

const retro = { ...scopeViolation(), judged: 'retroactive', recompute_id: 'recompute-1', source_ts: T0 - 7000, source_tier: 'chained', _causes: ['src-1', 'recompute-1'] }

const recompute = sys('scope_recomputed', {
  scope_hash_before: 'h0', scope_hash_after: 'h1', targets_count_before: 1, targets_count_after: 2,
  excludes_count_before: 0, excludes_count_after: 0, targets: ['10.0.0.0/24', '10.1.1.0/24'], excludes: [], scope_file: null,
  alert_floor: 'info', scanned: { targets: 4, moved: 1 }, recomputed: 4, newly_flagged: 1, newly_flagged_written: 1,
  newly_flagged_targets: ['10.1.1.1'], regraded: 0, regraded_written: 0, cleared: 1, cleared_written: 1, cleared_targets: ['10.0.0.9'],
  first_affected_at: T0 - 7000, last_affected_at: T0 - 6000, max_rows: 1000, duration_ms: 12,
  description: 'Scope recomputed: 4 re-judged, +1 newly flagged, −1 cleared', _causes: ['config-event-1']
})

const cleared = sys('scope_cleared', {
  target: '10.0.0.9', distance_before: 'out_of_scope', distance_after: 'in_scope', judged_before: 'retroactive',
  violation_id: 'viol-1', source_event_id: 'src-2', source_ts: T0 - 8000, recompute_id: 'recompute-1',
  description: 'Scope cleared: 10.0.0.9 (out_of_scope → in_scope)', _causes: ['viol-1', 'recompute-1']
})

const NO_INHERIT = 'the door does not believe `extracted` / `command` from a writer that did not pass inheritsVia, so the stamp says `explicit` and the hash follows'

// --- the case table ------------------------------------------------------------

const CASES: Case[] = [
  // #1 writeRecordingMarker. B: its publish bypasses the pause. E: the API's door.
  { name: 'recording_paused, ui toggle', site: 1, steps: [step('system', recording('recording_paused', 'ui'), 'bypass', { bypassPause: true })] },
  { name: 'recording_resumed with occurredAt (a retry lands at the toggle)', site: 1,
    steps: [step('system', recording('recording_resumed', 'ui'), 'bypass', { bypassPause: true }, { opts: { occurredAt: OCCURRED } })] },
  { name: 'recording_paused through the API door, entrance passed as an option', site: 1,
    steps: [step('system', recording('recording_paused', 'api'), 'bypass', { bypassPause: true }, { opts: { entrance: 'LEGACY_API' } })] },
  { name: 'recording_resumed under withEntrance(LEGACY_API)', site: 1, ctx: 'LEGACY_API',
    steps: [step('system', recording('recording_resumed', 'api'), 'bypass', { bypassPause: true })] },
  { name: 'recording_paused written while paused (system is pause-exempt)', site: 1, paused: true,
    steps: [step('system', recording('recording_paused', 'mcp'), 'bypass', { bypassPause: true })] },

  // #2 addHudMarker.
  { name: 'HUD marker on the operator-selected target', site: 2,
    steps: [step('marker', hudMarker(), 'bypass', { bypassPause: true }, { opts: { targetId: '10.0.0.5', targetVia: 'operator-selected' } })] },
  { name: 'HUD marker with no target', site: 2, steps: [step('marker', hudMarker(), 'bypass', { bypassPause: true })] },
  { name: 'HUD marker written while paused (marker is pause-exempt)', site: 2, paused: true,
    steps: [step('marker', hudMarker(), 'bypass', { bypassPause: true }, { opts: { targetId: '10.0.0.5', targetVia: 'operator-selected' } })] },

  { name: 'config_changed', site: 3, steps: [step('system', configChanged, 'plain')] },
  { name: 'config_changed while paused (written, publish blocked)', site: 3, paused: true, steps: [step('system', configChanged, 'plain')] },
  { name: 'opsec_state_changed', site: 4, steps: [step('system', sys('opsec_state_changed', {
    changed: { vpnInterfaces: { from: [], to: ['utun3'] } },
    current: { vpnInterfaces: ['utun3'], primaryMac: 'aa:bb:cc:dd:ee:ff', hostname: 'h', dnsServers: ['10.0.0.1'] }, description: 'VPN up: utun3' }), 'plain')] },
  { name: 'session_start (not published today)', site: 5, steps: [step('system', sys('session_start'), 'none')] },
  { name: 'opsec_airgap (not published today)', site: 6, steps: [step('system', sys('opsec_airgap', { enabled: true, description: 'Air-gap ON — no outbound anchoring / NTP / update / IP lookup' }), 'none')] },
  { name: 'chain_sample_broken at project open', site: 7, steps: [step('system', sys('chain_sample_broken', { eventId: 'e-9', reason: 'hash mismatch', sampled: 100 }), 'plain')] },
  { name: 'chain_sample_broken from the interval', site: 8, steps: [step('system', sys('chain_sample_broken', { eventId: 'e-9', reason: 'hash mismatch', sampled: 50 }), 'plain')] },
  { name: 'browser_launched', site: 9, steps: [step('system', sys('browser_launched', {
    binary: '/Applications/Chromium', proxy: '127.0.0.1:8080', cdpPort: 9222, isolatedProfile: true, pid: 4242 }), 'plain')] },
  { name: 'config_changed for a hook', site: 10, steps: [step('system', sys('config_changed', {
    changed: { 'hook.zsh.installed': { from: false, to: true } }, description: 'installed' }), 'plain')] },

  // #11 sweepDir: four subtypes, one per deleted file, with the cause when there is one.
  { name: 'cast_pruned', site: 11, steps: [step('system', prune('cast_pruned'), 'plain')] },
  { name: 'screenshot_pruned with _causes', site: 11, steps: [step('system', prune('screenshot_pruned', ['config-event-1']), 'plain')] },
  { name: 'agent_transcript_pruned', site: 11, steps: [step('system', prune('agent_transcript_pruned'), 'plain')] },
  { name: 'http_body_pruned', site: 11, steps: [step('system', prune('http_body_pruned'), 'plain')] },
  { name: 'retention_pruned_logged', site: 12, steps: [step('system', sys('retention_pruned_logged', {
    count: 40, bytes_freed: 12288, oldest_pruned_at: T0 - 9e6, newest_pruned_at: T0 - 8e6, keep_days: 30, sweep_duration_ms: 17,
    description: 'retention: pruned 40 logged-tier row(s), freed ~0 MB (30d policy)' }), 'plain')] },
  { name: 'bookmarks_pruned', site: 13, steps: [step('system', sys('bookmarks_pruned', { count: 2, keep_days: 30, description: 'Pruned 2 bookmark(s) older than 30d' }), 'plain')] },
  { name: 'body_evicted', site: 14, steps: [step('system', evicted('body_evicted'), 'plain')] },
  { name: 'cast_evicted', site: 15, steps: [step('system', evicted('cast_evicted'), 'plain')] },
  { name: 'screenshot_evicted', site: 15, steps: [step('system', evicted('screenshot_evicted'), 'plain')] },

  // #16-#18: one transaction, published after the commit with bypass.
  { name: 'scope recompute: summary, retroactive violation, cleared — in one transaction', site: 16, tx: true, steps: [
    step('system', recompute, 'bypass', { bypassPause: true }),
    step('system', retro, 'bypass', { bypassPause: true }, { opts: { targetId: '10.1.1.1' } }),
    step('system', cleared, 'bypass', { bypassPause: true }, { opts: { targetId: '10.0.0.9' } })
  ] },

  // #19 / #20 update-anchor. #19 names no engagement (G).
  { name: 'update_pending, engagement omitted', site: 19, steps: [step('system', sys('update_pending', {
    from_version: '0.20.0', to_version: '0.21.0', anchored_head: 'ff'.repeat(32), anchor_status: 'complete', external_timestamp: 'confirmed',
    gap_expected: true, description: '準備更新重啟：鏈頭已錨定（complete）；重啟安裝期間會有數秒不記錄' }), 'plain', {}, { engagement: 'omitted' })] },
  { name: 'update_completed', site: 20, steps: [step('system', sys('update_completed', {
    from_version: '0.20.0', to_version: '0.21.0', actual_version: '0.21.0', sessions_resumed: false, description: '已更新到 0.21.0（原 0.20.0）' }), 'plain')] },
  { name: 'update_not_applied', site: 20, steps: [step('system', sys('update_not_applied', {
    from_version: '0.20.0', to_version: '0.21.0', actual_version: '0.20.0', sessions_resumed: false, description: '更新沒有完成' }), 'plain')] },

  // #21 chain-anchor: no engagement passed, from /api/anchors under the API's door, not published today.
  { name: 'anchor_failed under withEntrance(LEGACY_API), engagement omitted', site: 21, ctx: 'LEGACY_API', steps: [step('system', sys('anchor_failed', {
    headHash: 'cd'.repeat(32), eventCount: 99, calendarsAttempted: 2,
    receipts: [{ calendar: 'https://a.example', ok: false, error: 'timeout' }, { calendar: 'https://b.example', ok: false, error: 'refused' }],
    description: 'OTS anchor failed across 2 calendars' }), 'none', {}, { engagement: 'omitted' })] },

  { name: 'logged_tier_digest from the API bundle export, under withEntrance(LEGACY_API)', site: 22, ctx: 'LEGACY_API', steps: [step('system', loggedDigest, 'plain')] },
  { name: 'export_sealed', site: 23, steps: [step('system', sys('export_sealed', {
    sealVersion: 1, exportId: 'export-1', bundleVersion: 4, manifestSha256: '12'.repeat(32),
    events: { count: 7, bytes: 4096, sha256: '34'.repeat(32), headHash: '56'.repeat(32) }, description: 'export sealed: 7 chained row(s), 3 file(s), 0 omitted attachment(s)' }), 'plain')] },
  { name: 'export_sealed by the stand-in operator of a project with no primary', site: 23, steps: [step('system', sys('export_sealed', {
    sealVersion: 1, exportId: 'export-2', bundleVersion: 4, manifestSha256: '78'.repeat(32),
    events: { count: 1, bytes: 128, sha256: '9a'.repeat(32), headHash: 'bc'.repeat(32) }, description: 'export sealed: 1 chained row(s), 3 file(s), 0 omitted attachment(s)' }), 'plain', {}, { operator: 'unattributed-export' })] },
  { name: 'logged_tier_digest from in-process exportBundle', site: 24, steps: [step('system', loggedDigest, 'plain')] },
  { name: 'sanitized under withEntrance(LEGACY_API)', site: 25, ctx: 'LEGACY_API', steps: [step('system', sys('sanitized', {
    source_events: ['e-1', 'e-2'], fields: ['stdout'], reason: 'client handoff',
    replacements: [{ event: 'e-1', field: 'stdout', sha256: 'de'.repeat(32) }] }), 'plain')] },

  // #26 loot. V: the via is the source row's, handed on.
  { name: 'loot from ingest\'s after-commit step (DERIVED), the source row\'s target `extracted`', site: 26, drive: 'loot',
    steps: [step('loot', lootRow(), 'plain', { inheritsVia: true })] },
  { name: 'loot, DERIVED, via `command` (a background job\'s chunk)', site: 26, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', { inheritsVia: true }, { opts: { targetId: '10.9.9.9', targetVia: 'command' } })] },
  { name: 'loot, DERIVED, via `operator-selected`', site: 26, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', { inheritsVia: true }, { opts: { targetId: '10.9.9.9', targetVia: 'operator-selected' } })] },
  { name: 'loot, DERIVED, via `explicit`', site: 26, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', { inheritsVia: true }, { opts: { targetId: '10.9.9.9', targetVia: 'explicit' } })] },
  { name: 'loot, DERIVED, no target', site: 26, ctx: 'DERIVED', steps: [step('loot', lootRow(), 'plain', { inheritsVia: true })] },
  { name: 'loot from /api/loot/scan under withEntrance(LEGACY_API)', site: 26, ctx: 'LEGACY_API',
    steps: [step('loot', lootRow({ source: 'POST /api/loot/scan' }), 'plain', { inheritsVia: true }, { opts: { targetId: '10.9.9.9' } })] },
  { name: 'loot while paused: refused both ways (loot is not pause-exempt)', site: 26, paused: true, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', { inheritsVia: true }, { opts: { targetId: '10.9.9.9', targetVia: 'extracted' } })] },
  { name: 'loot, via `extracted`, WITHOUT inheritsVia', site: 26, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', {}, { opts: { targetId: '10.9.9.9', targetVia: 'extracted' } })],
    differs: { fields: ['events[0].data._ingest.target_via', 'events[0].hash', 'events[0].signature'], why: NO_INHERIT } },
  { name: 'loot, via `command`, WITHOUT inheritsVia', site: 26, ctx: 'DERIVED',
    steps: [step('loot', lootRow(), 'plain', {}, { opts: { targetId: '10.9.9.9', targetVia: 'command' } })],
    differs: { fields: ['events[0].data._ingest.target_via', 'events[0].hash', 'events[0].signature'], why: NO_INHERIT } },

  // #27 ChainEmitter.
  { name: 'ip_verdict', site: 27, steps: [step('system', sys('ip_verdict', { authority: 'fact', severity: 'warn', ip_verdict_kind: 'exposed', settling: true }), 'plain')] },
  { name: 'scope_violation from ingest\'s scope dispatch (DERIVED)', site: 27, drive: 'scope',
    steps: [step('system', scopeViolation(), 'plain')] },
  { name: 'scope_violation outside ingest (an agent tool_call), in-process', site: 27,
    steps: [step('system', scopeViolation({ source: 'agent_tool' }), 'plain', {}, { opts: { targetId: '10.1.1.1' } })] },

  // #28 marker-amend. B: the IPC handler publishes with bypass. V: the original's via.
  { name: 'marker amendment of an operator-selected marker', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true }, { opts: { targetId: '10.0.0.5', targetVia: 'operator-selected' } })] },
  { name: 'marker amendment of an explicit marker', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true }, { opts: { targetId: '10.0.0.5', targetVia: 'explicit' } })] },
  { name: 'marker amendment of a marker whose via is `extracted`', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true }, { opts: { targetId: '10.0.0.5', targetVia: 'extracted' } })] },
  { name: 'marker amendment of a marker whose via is `command`', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true }, { opts: { targetId: '10.0.0.5', targetVia: 'command' } })] },
  { name: 'marker amendment of a marker with no target', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true })] },
  { name: 'marker amendment while paused', site: 28, paused: true,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true, inheritsVia: true }, { opts: { targetId: '10.0.0.5', targetVia: 'explicit' } })] },
  { name: 'marker amendment of an `extracted` marker, WITHOUT inheritsVia', site: 28,
    steps: [step('marker', amended(), 'bypass', { bypassPause: true }, { opts: { targetId: '10.0.0.5', targetVia: 'extracted' } })],
    differs: { fields: ['events[0].data._ingest.target_via', 'events[0].hash', 'events[0].signature'], why: NO_INHERIT } },

  { name: 'screenshot_deleted', site: 29, steps: [step('system', sys('screenshot_deleted', {
    source_event: 'shot-1', _causes: ['shot-1'], path: 'a.png', sha256_pre_delete: 'f0'.repeat(32) }), 'plain')] },
  { name: 'config_changed for a plugin', site: 30, steps: [step('system', sys('config_changed', {
    changed: { 'plugin.example.enabled': { from: false, to: true } }, description: 'plugin example enabled' }), 'plain')] }
]

// --- the two ways of writing ---------------------------------------------------

async function loadGraph() {
  // A fresh module graph per side: the chain head cache, the clock-anomaly
  // check and the bus are per-process state, and the two sides must not share them.
  vi.resetModules()
  const db = await import('../src/core/db/index')
  const events = await import('../src/core/db/events')
  const ops = await import('../src/core/db/operators')
  const ing = await import('../src/core/ingest')
  const stamp = await import('../src/core/ingest/stamp')
  const bus = await import('../src/core/event-bus')
  const body = await import('../src/core/http-body-index')
  return { db, events, ops, ing, stamp, bus, body }
}
type Graph = Awaited<ReturnType<typeof loadGraph>>
type Mode = 'today' | 'door'
type Row = Record<string, unknown>

interface Outcome {
  tables: { events: Row[]; events_logged: Row[] }
  /** The id each step's write returned, null where nothing was stored. */
  returned: Array<string | null>
  /** How many times each stored row reached an event-bus subscriber. */
  delivered: number[]
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function writeStep(g: Graph, mode: Mode, s: Step, opts: { deferPublish?: Array<() => void> }): RedLogEvent | null {
  const entrance = s.opts?.entrance === 'LEGACY_API' ? g.stamp.LEGACY_API : undefined
  const engagementId = s.engagement === 'omitted' ? undefined : ENG
  const common = {
    operatorId: s.operator ?? OP,
    ...(s.opts?.targetId !== undefined ? { targetId: s.opts.targetId } : {}),
    ...(s.opts?.targetVia !== undefined ? { targetVia: s.opts.targetVia } : {}),
    ...(s.opts?.occurredAt !== undefined ? { occurredAt: s.opts.occurredAt } : {})
  }
  if (mode === 'today') {
    const ev = g.events.insertEvent(s.agent, s.data, { engagementId, ...common, ...(entrance ? { entrance } : {}) })
    const publish = (): void => {
      if (!ev || s.publish === 'none') return
      g.bus.eventBus.publish(ev, s.publish === 'bypass' ? { bypassPause: true } : undefined)
    }
    if (opts.deferPublish) opts.deferPublish.push(publish); else publish()
    return ev
  }
  const door = { engagementId: engagementId ?? g.stamp.engagementForWrite(undefined), ...common, ...s.later }
  if (entrance) return g.ing.ingest({ agentType: s.agent, data: s.data, ...door, entrance }).event
  return g.ing.ingestEvent(s.agent, s.data, door)
}

// What a shell command's after-commit steps need to reach the write.
const LOOT_TRIGGER = { subtype: 'command_end', command: 'curl http://10.9.9.9/login', terminalId: 't1', command_id: 'c1', exit_code: 0, stdout: 'ok' }
const SCOPE_TRIGGER = { subtype: 'command_start', command: 'curl http://10.1.1.1/admin', terminalId: 't1', command_id: 'c2' }

async function runSide(mode: Mode, root: string): Promise<Map<string, Outcome>> {
  // event-write.ts reads the clock once, at load, for the boot epoch in every
  // monotonic_ns: both graphs must load at the same instant.
  vi.setSystemTime(T0)
  const g = await loadGraph()
  const out = new Map<string, Outcome>()
  for (const [i, c] of CASES.entries()) {
    // The same clock, ids and monotonic counter on both sides, and strictly
    // later than the case before so the clock-anomaly check never fires.
    control.ns = BigInt(i + 1) * 1_000_000_000n
    control.prefix = i
    control.n = 0
    vi.setSystemTime(T0 + i * 120_000)
    g.ing._resetIngest()
    const dir = path.join(root, `case-${i}`)
    fs.mkdirSync(dir, { recursive: true })
    g.db.initDB(dir)
    g.db.bindDBEngagement(ENG)
    g.ops.ensurePrimaryOperator(OP, 'Equiv', 'token-equiv')
    const seen: string[] = []
    const listener = (e: RedLogEvent): void => { seen.push(e.id) }
    g.bus.eventBus.on('event', listener)
    try {
      if (c.paused) g.bus.eventBus.pause('unknown')
      const written: Array<RedLogEvent | null> = []
      const run = (): void => {
        const after: Array<() => void> = []
        const w = (s: Step): void => { written.push(writeStep(g, mode, s, { deferPublish: c.tx ? after : undefined })) }
        const inTx = (fn: () => void): void => { if (c.tx) g.db.getDB().transaction(fn)(); else fn() }
        if (c.drive === 'loot') {
          g.ing.configureIngest({ lootDetector: {
            findMatches: () => [{ ruleId: 'r', type: 'password', value: 'hunter2hunter2', line: 'password=hunter2', confidence: 'high' }],
            scan: () => [],
            emit: (_m, o) => { w({ ...c.steps[0], opts: { targetId: o.targetId, targetVia: o.targetVia } }); return true }
          } })
          g.ing.ingest({ agentType: 'shell', data: LOOT_TRIGGER, operatorId: OP, engagementId: ENG })
        } else if (c.drive === 'scope') {
          g.ing.configureIngest({ alertRuntime: { dispatchTargetHit: (hit) => { w({ ...c.steps[0], opts: { targetId: hit.target } }) } } })
          g.ing.ingest({ agentType: 'shell', data: SCOPE_TRIGGER, operatorId: OP, engagementId: ENG })
        } else {
          inTx(() => { for (const s of c.steps) w(s) })
        }
        for (const publish of after) publish()
      }
      if (c.ctx) g.stamp.withEntrance(c.ctx === 'LEGACY_API' ? g.stamp.LEGACY_API : g.stamp.DERIVED, run); else run()
      await flush()
      const tables = {
        events: g.db.getDB().prepare('SELECT rowid AS _rowid, * FROM events ORDER BY rowid').all() as Row[],
        events_logged: g.db.getDB().prepare('SELECT rowid AS _rowid, * FROM events_logged ORDER BY rowid').all() as Row[]
      }
      const stored = written.filter((e): e is RedLogEvent => e !== null)
      out.set(c.name, {
        tables,
        returned: written.map((e) => e?.id ?? null),
        delivered: stored.map((e) => seen.filter((id) => id === e.id).length)
      })
    } finally {
      g.bus.eventBus.off('event', listener)
      g.bus.eventBus.resume('unknown')
      g.body.closeHttpBodyIndex()
      g.db.closeDB()
    }
  }
  return out
}

/** Every field at which the two outcomes differ, as `table[row].column`, with
 *  `data` taken apart down to the `_ingest` keys. Empty when byte for byte equal. */
function differences(a: Outcome, b: Outcome): string[] {
  const found: string[] = []
  for (const table of ['events', 'events_logged'] as const) {
    const ra = a.tables[table], rb = b.tables[table]
    if (ra.length !== rb.length) found.push(`${table}: ${ra.length} row(s) today, ${rb.length} through the door`)
    for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
      for (const col of new Set([...Object.keys(ra[i]), ...Object.keys(rb[i])])) {
        if (ra[i][col] === rb[i][col]) continue
        if (col !== 'data') { found.push(`${table}[${i}].${col}`); continue }
        const da = JSON.parse(String(ra[i].data)) as Record<string, unknown>
        const db = JSON.parse(String(rb[i].data)) as Record<string, unknown>
        let named = false
        for (const key of new Set([...Object.keys(da), ...Object.keys(db)])) {
          if (JSON.stringify(da[key]) === JSON.stringify(db[key])) continue
          named = true
          if (key === '_ingest') {
            const sa = (da._ingest ?? {}) as Record<string, unknown>, sb = (db._ingest ?? {}) as Record<string, unknown>
            for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
              if (JSON.stringify(sa[k]) !== JSON.stringify(sb[k])) found.push(`${table}[${i}].data._ingest.${k}`)
            }
          } else found.push(`${table}[${i}].data.${key}`)
        }
        if (!named) found.push(`${table}[${i}].data (same keys and values, different text)`)
      }
    }
  }
  return found
}

/** A write reaches a subscriber once, unless the bus is paused and the call does not bypass. */
const deliveredToday = (c: Case, s: Step): number => (s.publish === 'bypass' || (s.publish === 'plain' && !c.paused) ? 1 : 0)
const deliveredByDoor = (c: Case, s: Step): number => (!c.paused || s.later.bypassPause ? 1 : 0)

sqlite.describe('the row is the same through the door (T037)', () => {
  let root: string
  let today: Map<string, Outcome>
  let door: Map<string, Outcome>

  beforeAll(async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() =>
      `00000000-0000-4000-${String(control.prefix).padStart(4, '0')}-${String(++control.n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
    vi.spyOn(os, 'hostname').mockReturnValue('equiv-host')
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-eq-'))
    today = await runSide('today', path.join(root, 'today'))
    door = await runSide('door', path.join(root, 'door'))
  }, 180_000)

  afterAll(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  it('covers each of the thirty call sites', () => {
    expect([...new Set(CASES.map((c) => c.site))].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => ![17, 18].includes(n)))
    // #17 and #18 are the second and third write of the recompute transaction.
    expect(CASES.find((c) => c.site === 16)?.steps.map((s) => s.data.subtype)).toEqual(['scope_recomputed', 'scope_violation', 'scope_cleared'])
    expect(new Set(CASES.map((c) => c.name)).size, 'case names are keys').toBe(CASES.length)
  })

  for (const c of CASES) {
    it(`#${c.site} ${c.name}`, () => {
      const a = today.get(c.name)!, b = door.get(c.name)!
      // The drive cases write through a stub the shell row's after-commit step calls: it must have been reached.
      const writes = c.steps.length
      const expectedWrites = c.paused && c.drive ? 0 : writes
      expect(a.returned.length, 'writes made today').toBe(expectedWrites)
      expect(b.returned.length, 'writes made through the door').toBe(expectedWrites)
      // Whether each write landed is the same both ways. Loot written while paused lands neither way.
      expect(b.returned.map((id) => id !== null), 'which writes landed').toEqual(a.returned.map((id) => id !== null))
      if (c.paused && c.steps[0].agent === 'loot') expect(a.returned.every((id) => id === null), 'loot is refused while paused').toBe(true)
      else expect(a.returned.every((id) => id !== null), 'every write landed').toBe(true)

      const diff = differences(a, b)
      if (c.differs) {
        expect(diff, c.differs.why).toEqual(c.differs.fields)
        return
      }
      expect(diff, 'fields that differ between insertEvent and the door').toEqual([])
      if (!c.paused || c.steps[0].agent !== 'loot') {
        const rows = a.tables.events.length + a.tables.events_logged.length
        expect(rows, 'a row is stored, so the comparison compared something').toBeGreaterThanOrEqual(c.steps.length)
      }
    })

    it(`#${c.site} ${c.name} — published once through the door`, () => {
      const a = today.get(c.name)!, b = door.get(c.name)!
      const stored = c.steps.filter((_, i) => b.returned[i] !== null)
      if (c.drive && c.paused) return
      expect(b.delivered, 'deliveries per row through the door').toEqual(stored.map((s) => deliveredByDoor(c, s)))
      expect(a.delivered, 'deliveries per row today, from the hand-written publish').toEqual(stored.map((s) => deliveredToday(c, s)))
    })
  }

  it('a derived row is stamped `derived`; a row written under the API door, `legacy-api`; the door never changes either', () => {
    const stampOf = (name: string, table: 'events' | 'events_logged' = 'events'): { door: string; producer: string } => {
      const rows = door.get(name)!.tables[table].filter((r) => ['loot', 'system'].includes(String(r.agent_type)))
      const last = rows[rows.length - 1]
      return (JSON.parse(String(last.data)) as { _ingest: { door: string; producer: string } })._ingest
    }
    expect(stampOf('loot from ingest\'s after-commit step (DERIVED), the source row\'s target `extracted`')).toMatchObject({ door: 'in-process', producer: 'derived' })
    expect(stampOf('loot from /api/loot/scan under withEntrance(LEGACY_API)')).toMatchObject({ door: 'legacy-api', producer: 'legacy' })
    expect(stampOf('config_changed')).toMatchObject({ door: 'in-process', producer: 'in-process' })
  })
})

sqlite.describe('what the door does that a direct call does not', () => {
  it('publishes inside a transaction that then rolls back: why the recompute needs one publish after the commit', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-9000-${String(++control.n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-door-eq-tx-'))
    const g = await loadGraph()
    const seen: string[] = []
    const listener = (e: RedLogEvent): void => { seen.push(e.id) }
    g.bus.eventBus.on('event', listener)
    try {
      g.db.initDB(dir)
      g.db.bindDBEngagement(ENG)
      g.ops.ensurePrimaryOperator(OP, 'Equiv', 'token-equiv')
      expect(() => g.db.getDB().transaction(() => {
        g.ing.ingestEvent('system', sys('scope_recomputed'), { engagementId: ENG, operatorId: OP, bypassPause: true })
        throw new Error('a later write in the same transaction fails')
      })()).toThrow('a later write')
      await flush()
      const stored = (g.db.getDB().prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n
      expect({ stored, published: seen.length }).toEqual({ stored: 0, published: 1 })
    } finally {
      g.bus.eventBus.off('event', listener)
      g.body.closeHttpBodyIndex()
      g.db.closeDB()
      vi.restoreAllMocks()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
