import { getDB } from './db/index'
import { detectHooks } from './hooks-manager'

// "You are recording nothing" is the worst silent failure an audit tool can
// have. This module answers, at a glance: which capture sources are actually
// feeding events right now, and is anything feeding at all?

export type SourceState = 'active' | 'idle' | 'absent'

export interface CaptureSource {
  id: string
  /** installed / available where that's knowable (hooks), else undefined */
  installed?: boolean
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
   *  audit rows have been tampered with. */
  lastSampleBroken?: { at: number; eventId: string; reason: string }
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
}
export function clearDbError(): void { _lastDbError = null }
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
let _lastSampleBroken: { at: number; eventId: string; reason: string } | null = null
let _lastSampleOkAt: number | null = null
const SAMPLE_BROKEN_TTL_MS = 60 * 60 * 1000

export function noteSampleBroken(details: { eventId: string; reason: string }): void {
  _lastSampleBroken = { at: Date.now(), eventId: details.eventId, reason: details.reason.slice(0, 300) }
}
export function noteSampleOk(): void { _lastSampleOkAt = Date.now() }
export function clearSampleBroken(): void { _lastSampleBroken = null }
export function getLastSampleBroken(): { at: number; eventId: string; reason: string } | null {
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
  const row = db.prepare(
    `SELECT MAX(timestamp) AS t FROM events WHERE ${where}`
  ).get(...params) as { t: number | null } | undefined
  return row?.t ?? null
}

function stateFrom(installed: boolean | undefined, last: number | null, now: number): SourceState {
  if (installed === false) return 'absent'
  if (last !== null && now - last <= ACTIVE_WINDOW_MS) return 'active'
  return 'idle'
}

// detectHooks() runs `which` via execSync — cheap once, but getCaptureHealth is
// on a hot path (every new event + every status poll), and doing synchronous
// subprocess spawns there blocks the main process and freezes the UI. Hook
// install status barely changes during a session (and Settings re-detects on
// install), so cache it briefly.
let hooksCache: { at: number; value: ReturnType<typeof detectHooks> } | null = null
const HOOKS_TTL_MS = 15_000

function cachedHooks(now: number): ReturnType<typeof detectHooks> {
  if (hooksCache && now - hooksCache.at < HOOKS_TTL_MS) return hooksCache.value
  let value: ReturnType<typeof detectHooks> = []
  try { value = detectHooks() } catch { /* hooks dir unreadable */ }
  hooksCache = { at: now, value }
  return value
}

export function invalidateHooksCache(): void { hooksCache = null }

export function getCaptureHealth(now = Date.now()): CaptureHealth {
  const hooks = cachedHooks(now)
  const hookInstalled = (id: string): boolean | undefined => hooks.find((h) => h.id === id)?.installed

  // Claude Code hook writes agent events with subtype claude_code_bash.
  const claudeLast = lastEventFor(`agent_type = 'agent' AND data LIKE '%claude_code_bash%'`)
  // Shell preexec / agent-shell hooks write shell command_start/command_end
  // (NOT the builtin terminal, which sets source = 'builtin-terminal').
  const shellHookLast = lastEventFor(
    `agent_type = 'shell' AND json_extract(data,'$.subtype') IN ('command_start','command_end') AND coalesce(json_extract(data,'$.source'),'') != 'builtin-terminal'`
  )
  // mitmproxy addon writes scanner http_request/http_error events.
  const mitmLast = lastEventFor(`agent_type = 'scanner'`)
  // RedLog's own terminal panes.
  const builtinLast = lastEventFor(`agent_type = 'shell' AND json_extract(data,'$.source') = 'builtin-terminal'`)

  const sources: CaptureSource[] = [
    { id: 'shell-hook', installed: hookInstalled('shell-zsh') ?? hookInstalled('shell-bash') ?? hookInstalled('shell-powershell'), lastEventAt: shellHookLast, state: stateFrom(hookInstalled('shell-zsh') ?? hookInstalled('shell-bash') ?? hookInstalled('shell-powershell'), shellHookLast, now) },
    { id: 'claude-code', installed: hookInstalled('claude-code'), lastEventAt: claudeLast, state: stateFrom(hookInstalled('claude-code'), claudeLast, now) },
    { id: 'mitmproxy', installed: undefined, lastEventAt: mitmLast, state: stateFrom(undefined, mitmLast, now) },
    { id: 'builtin-terminal', installed: undefined, lastEventAt: builtinLast, state: stateFrom(undefined, builtinLast, now) }
  ]

  const activeCount = sources.filter((s) => s.state === 'active').length
  // "recording" = at least one source has fed a real event ever (not just recently).
  const everFed = sources.some((s) => s.lastEventAt !== null)
  // A source is "wired" if installed, or (for non-hook sources) has ever fed.
  const anyWired = sources.some((s) => s.installed === true) || sources.some((s) => s.installed === undefined && s.lastEventAt !== null)

  const lastDbError = getLiveDbError(now)
  const lastSampleBroken = getLiveSampleBroken(now)

  let verdict: CaptureHealth['verdict']
  // Chain-tamper trumps every other verdict — every source could be humming
  // and the log would still be lies.
  if (lastSampleBroken) verdict = 'dark'
  else if (lastDbError) verdict = 'dark'  // DB write failing beats any source verdict
  else if (!anyWired && !everFed) verdict = 'dark'
  else if (activeCount === 0) verdict = 'partial'
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
