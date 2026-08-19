import { getDB } from './db/index'
import { detectHooks, invalidateCommandCache } from './hooks-manager'

// "You are recording nothing" is the worst silent failure an audit tool can
// have. This module answers, at a glance: which capture sources are actually
// feeding events right now, and is anything feeding at all?

// v0.9.7: `off` joins the set. Previously a source the operator had never
// turned on was indistinguishable from one that was on but silent — both read
// as `idle`, and the card listed all eight regardless, so most of it was
// permanently grey noise. Installation and activation are now separate axes:
//   installed — the hook exists on disk (only meaningful for hook sources)
//   enabled   — the operator switched it on in config
export type SourceState = 'active' | 'idle' | 'absent' | 'off'

export interface CaptureSource {
  id: string
  /** installed / available where that's knowable (hooks), else undefined */
  installed?: boolean
  /** Hook id for installHook()/uninstallHook(). Absent = nothing to install;
   *  the source ships with the app and is governed by `enabled` alone. */
  hookId?: string
  /** Config switch state. `undefined` = always on, no switch to offer. */
  enabled?: boolean
  /** Dotted config path the switch writes, e.g. `clipboard.enabled`. */
  configPath?: string
  /** ms epoch of the most recent event attributable to this source, or null */
  lastEventAt: number | null
  state: SourceState
}

export interface CaptureHealth {
  verdict: 'healthy' | 'partial' | 'dark'
  /** true when NO source has produced a real (non-system) event recently */
  recording: boolean
  sources: CaptureSource[]
  lastEventAt: number | null
  checkedAt: number
  /** Most-recent capture-side DB write failure (SQLITE_BUSY, disk-full, project
   *  already closed, …). Prior to v0.6.86 these were swallowed by bare
   *  catch{} in every capture callsite, so the recording indicator kept
   *  pulsing red even when nothing was landing. Now the callsites forward
   *  the error via `noteDbError()` and it surfaces here + in StatusBar. */
  lastDbError?: { source: string; at: number; message: string }
  /** v0.6.89 P1-A: most recent chain-sample failure. Pins verdict to `dark`
   *  for the TTL window even if all sources are otherwise healthy — a
   *  broken chain is worse than a dark capture, since it means historical
   *  audit rows have been tampered with.
   *
   *  v0.7.6 H3: `eventTimestamp` carries the broken row's own creation
   *  time so the Dashboard can render "6d old" alongside the eventId —
   *  operators can tell at a glance whether the flag is a fresh
   *  regression or a pre-v0.7.x historical event they can't do anything
   *  about (see the 2026-08-01 `system/ip_transition` case that
   *  triggered this UX change). */
  lastSampleBroken?: { at: number; eventId: string; reason: string; eventTimestamp?: number }
  /** Timestamp of the most-recent verifyRandomSample that returned ok:true.
   *  Dashboard renders this as "sampled Xm ago" so operators can see the
   *  background verify is actually running. */
  lastSampleOkAt?: number | null
}

// Ring buffer of one — we only need "was there recently an error, and from
// where". Reset by `clearDbError()` (e.g. after a successful write from the
// same source, though callsites don't have to — the CaptureHealth consumer
// treats anything older than DB_ERROR_TTL_MS as gone).
let _lastDbError: { source: string; at: number; message: string } | null = null
const DB_ERROR_TTL_MS = 60_000

export function noteDbError(source: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  _lastDbError = { source, at: Date.now(), message: msg.slice(0, 200) }
  healthCache = null
}
export function clearDbError(): void { _lastDbError = null; healthCache = null }
function getLiveDbError(now: number): CaptureHealth['lastDbError'] {
  if (!_lastDbError) return undefined
  if (now - _lastDbError.at > DB_ERROR_TTL_MS) { _lastDbError = null; return undefined }
  return _lastDbError
}

// v0.6.89 P1-A: chain-sample-broken state. Longer TTL than DB errors —
// tampering is a serious event the operator must see, and a 60-min window
// keeps the dark verdict visible across sample runs (5-min timer + 60-min
// TTL means the dark state persists at least until the next 12 samples
// have had a chance to re-check).
let _lastSampleBroken: { at: number; eventId: string; reason: string; eventTimestamp?: number } | null = null
let _lastSampleOkAt: number | null = null
const SAMPLE_BROKEN_TTL_MS = 60 * 60 * 1000

// v0.7.6 H3: accept optional `eventTimestamp` so the Dashboard can show
// how old the broken row is. Callers that don't have it (older code
// paths, tests) still work — the field is optional end-to-end.
export function noteSampleBroken(details: { eventId: string; reason: string; eventTimestamp?: number }): void {
  // v0.9.8: these feed the verdict directly — a broken chain sample must go
  // dark on the very next read, not after the health cache TTL.
  healthCache = null
  _lastSampleBroken = {
    at: Date.now(),
    eventId: details.eventId,
    reason: details.reason.slice(0, 300),
    ...(details.eventTimestamp != null ? { eventTimestamp: details.eventTimestamp } : {})
  }
}
export function noteSampleOk(): void { healthCache = null; _lastSampleOkAt = Date.now() }
export function clearSampleBroken(): void { healthCache = null; _lastSampleBroken = null }
export function getLastSampleBroken(): { at: number; eventId: string; reason: string; eventTimestamp?: number } | null {
  if (!_lastSampleBroken) return null
  if (Date.now() - _lastSampleBroken.at > SAMPLE_BROKEN_TTL_MS) { _lastSampleBroken = null; return null }
  return _lastSampleBroken
}
function getLiveSampleBroken(now: number): CaptureHealth['lastSampleBroken'] {
  if (!_lastSampleBroken) return undefined
  if (now - _lastSampleBroken.at > SAMPLE_BROKEN_TTL_MS) { _lastSampleBroken = null; return undefined }
  return _lastSampleBroken
}

// A source is "active" if it produced an event within this window.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

// System events (api_started/session_start) are RedLog's own housekeeping — they
// don't prove anything is being captured, so they never count as "recording".
function lastEventFor(where: string, params: unknown[] = []): number | null {
  const db = getDB()
  // v0.9.8: ORDER BY ... LIMIT 1 rather than MAX(timestamp). MAX() is an
  // aggregate, so SQLite must visit every row matching the WHERE clause before
  // it can answer — and most of these predicates include a json_extract() that
  // no index can serve, so each probe scanned the whole agent_type bucket.
  // Ordered + limited, the (agent_type, timestamp DESC) index walks newest
  // first and stops at the first row that satisfies the json filter, which in
  // practice is one of the first few. Same answer, bounded work.
  //
  // v0.13.0: DNS + scanner + browser.console + agent.thinking + a few system
  // rows now land in `events_logged`. Capture-health measures "is this source
  // feeding events", which needs to see BOTH tiers — otherwise mitmproxy
  // running full-tilt on the logged tier would show as `idle`. Take the max
  // of both tables. The chained table stays authoritative for tie-break
  // (its row indexes are the smaller data set); the second query is a bounded
  // walk of `idx_events_logged_type_ts`.
  const chainedRow = db.prepare(
    `SELECT timestamp AS t FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT 1`
  ).get(...params) as { t: number | null } | undefined
  const loggedRow = db.prepare(
    `SELECT timestamp AS t FROM events_logged WHERE ${where} ORDER BY timestamp DESC LIMIT 1`
  ).get(...params) as { t: number | null } | undefined
  const chained = chainedRow?.t ?? null
  const logged = loggedRow?.t ?? null
  if (chained === null) return logged
  if (logged === null) return chained
  return chained > logged ? chained : logged
}

// getCaptureHealth runs eleven of those probes plus a hooks check. It is hit by
// the Dashboard poll, the StatusBar, every REST /api/status, and every agent
// calling redlog_status — the skill tells them to do that at session start.
// The answer is a freshness readout with a 10-minute active window, so a
// sub-second cache changes nothing an operator could perceive.
let healthCache: { at: number; value: CaptureHealth } | null = null
const HEALTH_TTL_MS = 750
export function invalidateCaptureHealthCache(): void { healthCache = null }

function stateFrom(
  installed: boolean | undefined,
  last: number | null,
  now: number,
  enabled?: boolean
): SourceState {
  // Switched off beats everything: the operator's explicit choice, not a
  // fault. Reported before `absent` so a hook that is both uninstalled and
  // disabled reads as the deliberate state rather than the broken one.
  if (enabled === false) return 'off'
  if (installed === false) return 'absent'
  if (last !== null && now - last <= ACTIVE_WINDOW_MS) return 'active'
  return 'idle'
}

// The live config, handed in by startProject / config:save. capture-health
// can't import loadConfig — it runs inside the same module graph the config
// loader pulls from — and it needs the switch states to tell `off` from
// `idle`. Same shape as the other configure* entry points.
let cfgSnapshot: Record<string, unknown> = {}
export function configureCaptureHealth(cfg: Record<string, unknown>): void {
  cfgSnapshot = cfg ?? {}
  // A switch flip must show up on the next read, not after the TTL.
  healthCache = null
}
function cfgFlag(path: string): boolean | undefined {
  let cur: unknown = cfgSnapshot
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'boolean' ? cur : undefined
}

// detectHooks() runs `which`/`where` via spawnSync — on Windows each `where`
// costs 70-300ms and we probe 4+ binaries, blocking the main process for 500ms+.
// Hook availability virtually never changes mid-session: the operator isn't
// installing mitmproxy while the app is open.  Cache for 2 minutes; Settings
// calls `invalidateHooksCache()` on open and after install/uninstall so the
// panel always shows fresh data.
let hooksCache: { at: number; value: ReturnType<typeof detectHooks> } | null = null
const HOOKS_TTL_MS = 120_000

function cachedHooks(now: number): ReturnType<typeof detectHooks> {
  if (hooksCache && now - hooksCache.at < HOOKS_TTL_MS) return hooksCache.value
  let value: ReturnType<typeof detectHooks> = []
  try { value = detectHooks() } catch { /* hooks dir unreadable */ }
  hooksCache = { at: now, value }
  return value
}

export function invalidateHooksCache(): void { hooksCache = null; healthCache = null; invalidateCommandCache() }

export function getCaptureHealth(now = Date.now()): CaptureHealth {
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value
  const value = computeCaptureHealth(now)
  healthCache = { at: now, value }
  return value
}

function computeCaptureHealth(now: number): CaptureHealth {
  const hooks = cachedHooks(now)
  const hookInstalled = (id: string): boolean | undefined => hooks.find((h) => h.id === id)?.installed

  // v0.9.7: the `claude-code` row is gone. That hook was retired in v0.7.3 —
  // the script is a no-op stub and its detectHooks() entry is commented out —
  // so `installed` was always undefined and the row rendered as a permanent
  // "idle" with an Install button that could not work. The agent-tailer row
  // below covers Claude Code (and Codex, and OpenCode) properly.
  // Shell preexec / agent-shell hooks write shell command_start/command_end
  // (NOT the builtin terminal, which sets source = 'builtin-terminal').
  const shellHookLast = lastEventFor(
    `agent_type = 'shell' AND json_extract(data,'$.subtype') IN ('command_start','command_end') AND coalesce(json_extract(data,'$.source'),'') != 'builtin-terminal'`
  )
  // mitmproxy addon writes scanner http_request/http_error events.
  const mitmLast = lastEventFor(`agent_type = 'scanner'`)
  // RedLog's own terminal panes.
  const builtinLast = lastEventFor(`agent_type = 'shell' AND json_extract(data,'$.source') = 'builtin-terminal'`)
  // v0.6.92: DNS/browser/process/file-watcher producers. `installed` is
  // undefined for these because "installed" doesn't really apply — the DNS
  // handler ships in the mitmproxy addon (so installation is coincident with
  // the mitmproxy source above but only counts as active if DNS mode is
  // actually running), and the others are always resident and turn on via
  // Settings.
  // v0.9.7: DNS is not a separate integration — `hooks/mitmproxy-addon.py`
  // serves both, switched by how the operator runs mitmdump (proxy mode vs
  // `--mode dns@5353`). Two rows implied two things to install and left one
  // of them permanently grey for everyone not running DNS mode. One row, fed
  // by either stream.
  const dnsLast = lastEventFor(`agent_type = 'dns'`)
  const browserLast = lastEventFor(`agent_type = 'browser'`)
  const processLast = lastEventFor(`agent_type = 'process'`)
  const fileWatcherLast = lastEventFor(`agent_type = 'file_transfer' AND json_extract(data,'$.source') = 'file-watcher'`)

  // v0.9.7: clipboard, the agent transcript tailer and the screenshot agent
  // are three of the loudest sources in the product and none of them appeared
  // on this card — an operator could have the tailer off and the health
  // readout would still say healthy.
  const clipboardLast = lastEventFor(`agent_type = 'clipboard'`)
  const tailerLast = lastEventFor(`agent_type = 'agent'`)
  const screenshotLast = lastEventFor(`agent_type = 'screenshot'`)

  const shellInstalled = hookInstalled('shell-zsh') ?? hookInstalled('shell-bash') ?? hookInstalled('shell-powershell')
  // Which concrete hook id an Install button should act on. Prefer whichever
  // is already known to the detector for this platform.
  const shellHookId = hooks.find((h) => h.id === (process.platform === 'win32' ? 'shell-powershell' : 'shell-zsh'))?.id
    ?? hooks.find((h) => h.id.startsWith('shell-'))?.id

  const mk = (
    id: string,
    last: number | null,
    opts: { installed?: boolean; hookId?: string; configPath?: string } = {}
  ): CaptureSource => {
    const enabled = opts.configPath ? cfgFlag(opts.configPath) : undefined
    return {
      id,
      installed: opts.installed,
      hookId: opts.hookId,
      enabled,
      configPath: opts.configPath,
      lastEventAt: last,
      state: stateFrom(opts.installed, last, now, enabled)
    }
  }

  const sources: CaptureSource[] = [
    mk('shell-hook', shellHookLast, { installed: shellInstalled, hookId: shellHookId }),
    mk('builtin-terminal', builtinLast),
    mk('agent-tailer', tailerLast, { configPath: 'agentTailer.enabled' }),
    mk('mitmproxy', Math.max(mitmLast ?? 0, dnsLast ?? 0) || null, {
      installed: hookInstalled('mitmproxy'), hookId: 'mitmproxy'
    }),
    mk('browser-console', browserLast),
    mk('screenshot', screenshotLast),
    mk('clipboard', clipboardLast, { configPath: 'clipboard.enabled' }),
    mk('process-monitor', processLast, { configPath: 'processMonitor.enabled' }),
    mk('file-watcher', fileWatcherLast, { configPath: 'fileWatcher.enabled' })
  ]

  const activeCount = sources.filter((s) => s.state === 'active').length
  // "recording" = at least one source has fed a real event ever (not just recently).
  const everFed = sources.some((s) => s.lastEventAt !== null)
  // A source is "wired" if installed, or (for non-hook sources) has ever fed.
  const anyWired = sources.some((s) => s.state !== 'off' && s.installed === true)
    || sources.some((s) => s.state !== 'off' && s.installed === undefined && s.lastEventAt !== null)
  // v0.6.96 Ops-3: a source is EXPECTED to feed if it's installed OR it has
  // ever fed. When such a source is currently idle (not active), the overall
  // verdict should tip to `partial` even if some OTHER source is still
  // healthy. Prior behaviour: shell-hook installed but silent for hours →
  // still "healthy" green if builtin-terminal was active. Now: partial.
  //
  // v0.9.7: a source the operator switched OFF is not "expected" — it is a
  // choice. Before this, disabling e.g. the process monitor after it had once
  // fed left the verdict pinned to `partial` forever, which trains operators
  // to ignore the one indicator that is supposed to mean something.
  const expectedSilent = sources.some((s) => {
    if (s.state === 'off') return false
    const expected = s.installed === true || (s.installed === undefined && s.lastEventAt !== null)
    return expected && s.state !== 'active'
  })

  const lastDbError = getLiveDbError(now)
  const lastSampleBroken = getLiveSampleBroken(now)

  let verdict: CaptureHealth['verdict']
  // Chain-tamper trumps every other verdict — every source could be humming
  // and the log would still be lies.
  if (lastSampleBroken) verdict = 'dark'
  else if (lastDbError) verdict = 'dark'  // DB write failing beats any source verdict
  else if (!anyWired && !everFed) verdict = 'dark'
  else if (activeCount === 0) verdict = 'partial'
  else if (expectedSilent) verdict = 'partial'  // v0.6.96 Ops-3
  else verdict = 'healthy'

  const lastEventAt = sources.reduce<number | null>(
    (acc, s) => (s.lastEventAt !== null && (acc === null || s.lastEventAt > acc) ? s.lastEventAt : acc),
    null
  )

  return {
    verdict, recording: everFed, sources, lastEventAt, checkedAt: now,
    lastDbError,
    lastSampleBroken,
    lastSampleOkAt: _lastSampleOkAt
  }
}
