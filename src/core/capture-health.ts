import os from 'node:os'
import { isMemberSelected, isPackAvailable, type CapturePackId, type PackMemberId } from './capture-packs'
import { listPlugins } from './plugins'
import { getDB } from './db/index'
import { detectHooks, invalidateCommandCache } from './hooks-manager'
import { listTerminalEnrollments } from './terminal-enrollment'

// "You are recording nothing" is the worst silent failure an audit tool can
// have. This module answers, at a glance: can each capture source record, and
// has anything ever been recorded?

// The state axis answers ONE question: can this source record right now.
//
//   ready  — set up and able to capture
//   unset  — nothing installed, nothing turned on; it cannot capture
//   off    — the operator switched it off. A choice, not a fault.
//   error  — it was asked to capture and the capture itself failed. Distinct
//            from `unset`, and from a DB write failure, which is a
//            whole-product fault rather than one source's.
//
// There is deliberately no `idle`. It used to sit between `active` and
// `absent`, and what it measured was the OPERATOR, not the capture: a terminal
// with nobody typing in it, a clipboard nobody copied to, a file watcher over
// a directory nobody touched. Worse, it was windowed — ten minutes — so the
// same machine with the same configuration flipped from healthy to amber and
// back with nothing changed, which teaches an operator to ignore the one
// indicator that must never be ignored.
//
// What is genuinely useful about time is kept, as DATA rather than as a
// verdict: `lastEventAt` is reported per source, and the UI shows its age.
// "Was recording and stopped" is detected by a liveness signal where one
// exists (a producer heartbeat, a managed process), never by silence — silence
// cannot tell a broken hook from a coffee break.
export type SourceState = 'ready' | 'unset' | 'off' | 'error'

export interface CaptureSource {
  id: string
  /** installed / available where that's knowable (hooks), else undefined */
  installed?: boolean
  /** Hook id for installHook()/uninstallHook(). Absent = nothing to install;
   *  the source ships with the app and is governed by `enabled` alone. */
  hookId?: string
  /** Config switch state. `undefined` = always on, no switch to offer. */
  enabled?: boolean
  /** Dotted config path the switch writes, e.g. `packMembers.clipboard`. */
  configPath?: string
  /** For a pack member: the pack's own path. Turning the member ON has to turn
   *  its pack on too, or the operator flips a switch and the row stays `off` —
   *  a control that reports the opposite of what it did. */
  packPath?: string
  /** ms epoch of the most recent event attributable to this source, or null */
  lastEventAt: number | null
  state: SourceState
  /** Most recent capture failure from this source, while it is still live
   *  (`CAPTURE_ERROR_TTL_MS`). Set by `noteCaptureError`; drives `state:
   *  'error'` and gives the panel something to say beyond the colour. */
  lastError?: { at: number; message: string }
  /** E3: a plugin-contributed capture producer, enumerated from the registry
   *  rather than the hardcoded core list. Informational sources are DISPLAY
   *  ONLY — they are appended after the verdict is computed and never feed
   *  `verdict`/`recording`, so a manual producer that the operator has not run
   *  (pcap-capture, transparent-proxy, a c2 tailer…) can never tip the
   *  recording indicator amber. See computeCaptureHealth. */
  informational?: boolean
  /** Human label for an informational source (the plugin's own name), since it
   *  has no core i18n `capture.*` entry. */
  label?: string
  /** The operator switched this source off, and it is listed anyway. These
   *  producers run outside RedLog, so switching them off never stopped them --
   *  it stopped RedLog saying so. `disabled` together with a live producer
   *  (`running`, or an event that just landed) is the one combination that
   *  means the record is taking data nobody authorised now. */
  disabled?: boolean
  /** E3: an informational plugin producer that has posted a `producer_heartbeat`
   *  recently — the operator has it RUNNING. This is the one case a plugin
   *  producer becomes "expected": a running producer that has stopped feeding is
   *  a real problem and DOES tip the verdict amber. An installed-but-never-run
   *  producer posts no heartbeat, so it stays out of the verdict (the #48/#49
   *  guarantee). */
  running?: boolean
  /** Spec 052: the operator's own terminals that have enrolled, and how many
   *  of them are recording right now. Absent when none have — which is the
   *  state the `terminal` row has always silently been in, and the one the
   *  card could not tell apart from "RedLog's own panes are covering it".
   *  `total` without `recording` is an operator who stopped it on purpose,
   *  not a capture that failed (FR-022). */
  enrolled?: { total: number; recording: number }
}

export interface CaptureHealth {
  verdict: 'healthy' | 'partial' | 'dark'
  /** at least one source has produced a real (non-system) event, ever.
   *
   *  NOT the REC switch. That one lives behind `/api/recording` and decides
   *  whether RedLog writes down what the sources produce; this one says
   *  whether anything has ever been written. They were both called
   *  `recording`, in the same product, one of them in a payload the other
   *  does not appear in. */
  hasRecorded: boolean
  sources: CaptureSource[]
  lastEventAt: number | null
  checkedAt: number
  /** Most-recent capture-side DB write failure (SQLITE_BUSY, disk-full, project
   *  already closed, …). Prior to v0.6.86 these were swallowed by bare
   *  catch{} in every capture callsite, so the recording indicator kept
   *  pulsing red even when nothing was landing. Now the callsites forward
   *  the error via `noteDbError()` and it surfaces here + in StatusBar. */
  lastDbError?: { source: string; at: number; message: string }
  /** Cumulative DB write error count for this session. Zero means the session
   *  has never had a write failure; non-zero after lastDbError clears means
   *  "recovered but had gaps". */
  dbErrorTotal: number
  /** Timestamp of the first DB error in this session, or null. */
  dbErrorFirstAt: number | null
  /** Most recent chain-sample failure. Pins verdict to `dark`
   *  for the TTL window even if all sources are otherwise healthy — a
   *  broken chain is worse than a dark capture, since it means historical
   *  audit rows have been tampered with.
   *
   *  `eventTimestamp` carries the broken row's own creation
   *  time so the Dashboard can render "6d old" alongside the eventId —
   *  operators can tell at a glance whether the flag is fresh or historical. */
  lastSampleBroken?: { at: number; eventId: string; reason: string; eventTimestamp?: number }
  managedHttpProxy?: {
    state: 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed'
    url: string | null
    error?: string
    caPath?: string
    certReady?: boolean
  }
}

let managedProxyStatusProvider: (() => CaptureHealth['managedHttpProxy']) | null = null
export function configureManagedProxyHealth(provider: () => CaptureHealth['managedHttpProxy']): void {
  managedProxyStatusProvider = provider
  healthCache = null
}

// The live DB error tracks "is writing currently broken". It auto-expires
// after DB_ERROR_TTL_MS so the verdict can recover without operator action.
// The cumulative counters (_dbErrorTotal, _dbErrorFirstAt) persist for the
// session lifetime so the health readout can distinguish "never had a
// problem" from "recovered but had N write failures earlier".
let _lastDbError: { source: string; at: number; message: string } | null = null
const DB_ERROR_TTL_MS = 60_000
let _dbErrorTotal = 0
let _dbErrorFirstAt: number | null = null

export function noteDbError(source: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const now = Date.now()
  _lastDbError = { source, at: now, message: msg.slice(0, 200) }
  _dbErrorTotal++
  if (_dbErrorFirstAt === null) _dbErrorFirstAt = now
  healthCache = null
}
// A capture-side failure that belongs to ONE source: the screen grab came
// back empty, the tailer's file vanished, the clipboard read threw. These used
// to go through `noteDbError`, which exists for "writing evidence is broken"
// and pins the whole verdict to `dark`. A camera that cannot see the screen is
// not a dark log — every other source is still recording — and reporting it
// that way teaches the operator to ignore the one signal that must never be
// ignored. It tips the owning source to `error` and the verdict to `partial`.
const CAPTURE_ERROR_TTL_MS = 10 * 60 * 1000
const _captureErrors = new Map<string, { at: number; message: string }>()

export function noteCaptureError(sourceId: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  _captureErrors.set(sourceId, { at: Date.now(), message: msg.slice(0, 200) })
  healthCache = null
}

/** The live failure for one source, for callers that need to say WHY right
 *  now rather than wait for the next health read. */
export function getCaptureError(sourceId: string): { at: number; message: string } | undefined {
  return getLiveCaptureError(sourceId, Date.now())
}

/** Called when a source captures successfully again, so the row recovers
 *  without waiting out the TTL. */
export function clearCaptureError(sourceId: string): void {
  if (_captureErrors.delete(sourceId)) healthCache = null
}

function getLiveCaptureError(sourceId: string, now: number): { at: number; message: string } | undefined {
  const e = _captureErrors.get(sourceId)
  if (!e) return undefined
  if (now - e.at > CAPTURE_ERROR_TTL_MS) { _captureErrors.delete(sourceId); return undefined }
  return e
}

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
export function clearSampleBroken(): void { healthCache = null; _lastSampleBroken = null }
function getLiveSampleBroken(now: number): CaptureHealth['lastSampleBroken'] {
  if (!_lastSampleBroken) return undefined
  if (now - _lastSampleBroken.at > SAMPLE_BROKEN_TTL_MS) { _lastSampleBroken = null; return undefined }
  return _lastSampleBroken
}

// "Fed recently" — no longer a state, and no longer anything an operator sees
// a colour for. Two uses are left, and both are about a source RedLog knows is
// live rather than about the operator's activity: which stream of the
// mitmproxy row is carrying traffic, and whether a producer that is
// heartbeating has stopped delivering.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
// E3: a plugin producer counts as "running" if it posted a heartbeat within
// this window. Producers heartbeat roughly every 15s, so 60s tolerates a
// missed beat or two without flapping.
const PRODUCER_HEARTBEAT_WINDOW_MS = 60 * 1000

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

function stateFrom(
  installed: boolean | undefined,
  last: number | null,
  enabled?: boolean
): SourceState {
  // Switched off beats everything: the operator's explicit choice, not a
  // fault. Reported before `unset` so a hook that is both uninstalled and
  // disabled reads as the deliberate state rather than the missing one.
  if (enabled === false) return 'off'
  // Evidence beats detection, and it has no expiry. A source that has ever
  // delivered an event IS set up, whatever the install probe believes, and
  // nothing about that stops being true ten minutes later.
  //
  // Two live sources hit this on Windows. `mitmproxy` is `installed: false`
  // by design — the managed proxy runs the addon with `-s <path>` instead of
  // installing the standalone hook — and the shell hook was mis-detected
  // outright (see shellInstalled below). Both reported "nothing installed
  // here" over their own events.
  if (last !== null) return 'ready'
  if (installed === false) return 'unset'
  return 'ready'
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
  // mitmproxy's installed-ness cannot come from `installed`. Its installMethod
  // is `manual`, and checkInstalled() answers `false` for every manual hook
  // unconditionally — so the row read `installed: false` on a machine with
  // mitmdump on PATH, the managed proxy running and HTTP events landing, and
  // the Dashboard's HTTP(S) line said 未安裝 mitmproxy through all of it.
  // `available` is the answer to the question the panel is actually asking:
  // is mitmdump on this machine. The addon ships with RedLog and the managed
  // proxy runs it with `-s <path>`, so nothing else is left to install.
  const hookAvailable = (id: string): boolean | undefined => hooks.find((h) => h.id === id)?.available

  // v0.9.7: the `claude-code` row is gone. That hook was retired in v0.7.3 —
  // the script is a no-op stub and its detectHooks() entry is commented out —
  // so `installed` was always undefined and the row rendered as a permanent
  // "idle" with an Install button that could not work. The agent-tailer row
  // below covers Claude Code (and Codex, and OpenCode) properly.
  // One terminal capability, fed by either terminal.
  //
  // This was two rows — the operator's own shell (via a preexec hook) and
  // RedLog's own panes (source = 'builtin-terminal') — and they are not two
  // things to choose between: they are the same capture, in two places. Side
  // by side they asked the operator which one they were supposed to be using,
  // and one of them was a row with nothing to install, enable or get wrong.
  // WHICH terminal a command came from is a property of the command, and the
  // event carries it (`data.source`, shown in the inspector's metadata).
  //
  // Commands only, from either: opening a pane writes a session_start, and a
  // pane with nothing typed in it has recorded nothing.
  const terminalLast = lastEventFor(
    `agent_type = 'shell' AND subtype IN ('command_start','command_end')`
  )
  // mitmproxy addon writes scanner http_request/http_error events.
  // mitmproxy and the connection monitor both land on agent_type='scanner';
  // split them by subtype so one does not light the other's indicator.
  const mitmLast = lastEventFor(`agent_type = 'scanner' AND subtype NOT IN ('connection','connection_end')`)
  const connLast = lastEventFor(`agent_type = 'scanner' AND subtype IN ('connection','connection_end')`)
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

  // Any shell hook being installed makes the row installed — `??` could not
  // express that, because `checkInstalled()` always returns a boolean, so
  // `false ?? x` short-circuits on the first candidate. On Windows that
  // candidate is `shell-zsh`, which is never installed, so the row read
  // `installed: false` no matter what the operator had wired up: the panel
  // said the shell hook was absent while PowerShell commands were landing.
  const SHELL_HOOK_IDS = ['shell-zsh', 'shell-bash', 'shell-powershell']
  const shellKnown = SHELL_HOOK_IDS.map(hookInstalled).filter((v) => v !== undefined)
  const shellInstalled = shellKnown.length > 0 ? shellKnown.some(Boolean) : undefined
  // Which concrete hook id an Install button should act on. Prefer whichever
  // is already known to the detector for this platform.
  const shellHookId = hooks.find((h) => h.id === (process.platform === 'win32' ? 'shell-powershell' : 'shell-zsh'))?.id
    ?? hooks.find((h) => h.id.startsWith('shell-'))?.id

  const mk = (
    id: string,
    last: number | null,
    opts: {
      installed?: boolean; hookId?: string; configPath?: string; packPath?: string
      /** The source exists whether or not its hook is installed, so `installed:
       *  false` must not make it `absent`. The terminal is the one: RedLog's
       *  own panes record with nothing installed, and the hook only widens the
       *  capture to the operator's own shell. `installed` still rides on the
       *  row — it is what the Install control acts on — it just does not get
       *  to say the capability is missing. */
      alwaysPresent?: boolean
    } = {}
  ): CaptureSource => {
    // A pack that is not set is off (Spec 035), not "unknown".
    //
    // A pack MEMBER is on when its pack is on and its own switch selects it,
    // so both halves are read — by the same rule the capture runtime uses
    // (isMemberSelected). An unset member follows its default: on for most,
    // which keeps the pack a preset; off for the clipboard, which needs an
    // explicit yes (#224).
    const packOn = opts.packPath ? cfgFlag(opts.packPath) === true : undefined
    const member = opts.configPath?.startsWith('packMembers.')
      ? opts.configPath.slice('packMembers.'.length) as PackMemberId
      : null
    const enabled = opts.packPath
      ? packOn === true && member !== null && isMemberSelected({ [member]: cfgFlag(opts.configPath as string) }, member)
      : opts.configPath
        ? cfgFlag(opts.configPath) ?? (opts.configPath.startsWith('packs.') ? false : undefined)
        : undefined
    const lastError = getLiveCaptureError(id, now)
    const state = stateFrom(opts.alwaysPresent ? undefined : opts.installed, last, enabled)
    // An event that landed AFTER the failure says the source recovered. This
    // used to be "the source is active" — fed within ten minutes — which
    // cleared a failure that was still live whenever some older event fell
    // inside the window, and reinstated it when the window moved on.
    const recovered = lastError !== undefined && last !== null && last > lastError.at
    return {
      id,
      installed: opts.installed,
      hookId: opts.hookId,
      enabled,
      configPath: opts.configPath,
      ...(opts.packPath ? { packPath: opts.packPath } : {}),
      lastEventAt: last,
      // A live capture failure outranks `ready`/`unset` — the source tried and
      // could not — but not `off`, which is the operator's own choice, nor a
      // recovery.
      state: lastError && !recovered && state !== 'off' ? 'error' : state,
      ...(lastError ? { lastError } : {})
    }
  }

  // The operator's own terminals, from the state file they and RedLog share
  // (`~/.redlog/terminals/`). Read here rather than inferred from events,
  // because the thing worth saying is what a terminal WILL do at the next
  // prompt — an enrolled terminal that nobody has typed in yet has produced
  // no events and is working perfectly.
  const enrolledTerminals = (): { enrolled?: CaptureSource['enrolled'] } => {
    const all = listTerminalEnrollments(os.homedir())
    if (all.length === 0) return {}
    return { enrolled: { total: all.length, recording: all.filter((t) => t.recording).length } }
  }

  const sources: CaptureSource[] = [
    // One row for both terminals. `installed` is the operator's own shell hook
    // — the only half there is anything to install — and `alwaysPresent` keeps
    // that from reading as "terminal capture is missing" when RedLog's own
    // panes are recording perfectly well without it.
    { ...mk('terminal', terminalLast, { installed: shellInstalled, hookId: shellHookId, alwaysPresent: true }),
      ...enrolledTerminals() },
    mk('agent-tailer', tailerLast, { configPath: 'packMembers.agentTailer', packPath: 'packs.aiAgents' }),
    // One row for HTTP and DNS: the addon serves both, and a second row sits
    // permanently grey for everyone not running DNS mode. It used to carry a
    // `streams` note saying which of the two had traffic in the last ten
    // minutes — a report on the target's traffic, not on RedLog's capture,
    // and the last of that family left on the card.
    mk('mitmproxy', Math.max(mitmLast ?? 0, dnsLast ?? 0) || null, {
      installed: hookAvailable('mitmproxy'), hookId: 'mitmproxy'
    }),
    mk('browser-console', browserLast),
    mk('connection-monitor', connLast, { configPath: 'packMembers.connectionMonitor', packPath: 'packs.hostMonitors' }),
    mk('screenshot', screenshotLast),
    mk('clipboard', clipboardLast, { configPath: 'packMembers.clipboard', packPath: 'packs.hostMonitors' }),
    mk('process-monitor', processLast, { configPath: 'packMembers.processMonitor', packPath: 'packs.hostMonitors' }),
    mk('file-watcher', fileWatcherLast, { configPath: 'packMembers.fileWatcher', packPath: 'packs.hostMonitors' })
  ].filter((src) => {
    // Spec 035: a pack whose plugin is disabled or missing is removed, not
    // shown as "off" — its sources are not offered at all.
    //
    // Read from `packPath`, not `configPath`: a member's own switch now lives
    // at `packMembers.<member>`, so keying the removal off `configPath` would
    // have silently stopped removing anything and left every host-monitor row
    // on the card for a pack whose plugin was gone.
    const pack = src.packPath?.startsWith('packs.') ? src.packPath.slice(6) as CapturePackId : null
    return !pack || isPackAvailable(pack, listPlugins())
  })

  // E3: PLUGIN-contributed capture producers, enumerated from the registry
  // rather than a second hardcoded list. detectHooks() already merges them with
  // the built-ins (their namespaced `<pluginId>.<captureId>` ids are the only
  // ones carrying a dot). When a producer's manifest declares `emits`, we give
  // it a REAL feed readout — the last event of its agentType with one of those
  // subtypes — so a live pcap/transparent-proxy/c2 tailer shows `active`, a
  // stale one `idle`, an unrun one `off` (not a fault: a manual producer that
  // simply isn't running).
  const pluginSources: CaptureSource[] = hooks
    .filter((h) => h.id.includes('.'))
    .map((h) => {
      const emits = h.emits ?? []
      let last: number | null = null
      if (emits.length > 0) {
        const placeholders = emits.map(() => '?').join(',')
        last = lastEventFor(
          `agent_type = ? AND subtype IN (${placeholders})`,
          [h.agentType, ...emits]
        )
      }
      // E3: is the operator running this producer right now? A running producer
      // posts `system.producer_heartbeat` with its pluginId periodically; a
      // recent one means "running". No stop event is needed — heartbeats age out.
      const pluginId = h.id.split('.')[0]
      const hbLast = lastEventFor(
        `agent_type = 'system' AND subtype = 'producer_heartbeat' AND json_extract(data,'$.producer') = ?`,
        [pluginId]
      )
      const running = hbLast !== null && now - hbLast <= PRODUCER_HEARTBEAT_WINDOW_MS
      // Running, or it has delivered before → it can record. Never run and
      // never fed → off, which for a manual producer is not a fault: it is a
      // thing the operator starts when they want it.
      const state: SourceState = running || last !== null ? 'ready' : 'off'
      return { id: h.id, label: h.name, installed: h.installed, lastEventAt: last, state, informational: true, running, disabled: h.disabled === true }
    })

  // The verdict ASYMMETRY that keeps the trust signal honest: plugin producers
  // may only make the picture BETTER, never worse. One that has delivered
  // counts toward `recording`/`wired` (it IS capture happening) — but an
  // installed-but-never-run manual producer can NEVER tip the indicator amber.
  // That is the guarantee test/capture-health pins.
  //
  // "recording" = at least one source has fed a real event ever.
  const everFed = sources.some((s) => s.lastEventAt !== null) || pluginSources.some((s) => s.lastEventAt !== null)
  // A source is "wired" if installed, or (for non-hook / plugin sources) has ever fed.
  const anyWired = sources.some((s) => s.state !== 'off' && s.installed === true)
    || sources.some((s) => s.state !== 'off' && s.installed === undefined && s.lastEventAt !== null)
    || pluginSources.some((s) => s.lastEventAt !== null)
  // The one "was recording and stopped" we can actually prove: a producer the
  // operator is RUNNING right now — it says so itself, every 15 seconds — that
  // has delivered nothing lately. This is the shape the whole `idle` state
  // used to be a bad guess at, and the reason removing `idle` loses nothing:
  // silence alone cannot tell a broken producer from an operator at lunch, but
  // silence from something that is still announcing itself can.
  //
  // Producers with no heartbeat are untouched (the installed-but-not-run
  // guarantee holds), and no core source feeds this: none of them has a
  // liveness signal yet.
  const producerStalled = pluginSources.some(
    (s) => s.running === true && (s.lastEventAt === null || now - s.lastEventAt > ACTIVE_WINDOW_MS)
  )

  // A source whose own capture is failing tips the verdict amber. It must not
  // go dark: the other sources are recording, and `dark` means "you have no
  // log".
  const anySourceErrored = sources.some((s) => s.state === 'error')

  const lastDbError = getLiveDbError(now)
  const lastSampleBroken = getLiveSampleBroken(now)

  let verdict: CaptureHealth['verdict']
  // Chain-tamper trumps every other verdict — every source could be humming
  // and the log would still be lies.
  if (lastSampleBroken) verdict = 'dark'
  else if (lastDbError) verdict = 'dark'  // DB write failing beats any source verdict
  else if (!anyWired && !everFed) verdict = 'dark'
  // Something is broken, or something the operator is running has gone quiet.
  //
  // And nothing else. Set up and nothing has come through is not a fault: a
  // proxy with no traffic is a proxy nobody has sent traffic to, the same way
  // Burp's listener is simply running. Whether the operator has done anything
  // yet is answered by `recording` and by each source's `lastEventAt`, which
  // the UI shows as an age — not by grading the capture amber.
  else if (anySourceErrored || producerStalled) verdict = 'partial'
  else verdict = 'healthy'

  const lastEventAt = [...sources, ...pluginSources].reduce<number | null>(
    (acc, s) => (s.lastEventAt !== null && (acc === null || s.lastEventAt > acc) ? s.lastEventAt : acc),
    null
  )

  return {
    verdict, hasRecorded: everFed, sources: [...sources, ...pluginSources], lastEventAt, checkedAt: now,
    lastDbError,
    dbErrorTotal: _dbErrorTotal,
    dbErrorFirstAt: _dbErrorFirstAt,
    lastSampleBroken,
    managedHttpProxy: managedProxyStatusProvider?.()
  }
}
