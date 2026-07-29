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

  let verdict: CaptureHealth['verdict']
  if (!anyWired && !everFed) verdict = 'dark'
  else if (activeCount === 0) verdict = 'partial'
  else verdict = 'healthy'

  const lastEventAt = sources.reduce<number | null>(
    (acc, s) => (s.lastEventAt !== null && (acc === null || s.lastEventAt > acc) ? s.lastEventAt : acc),
    null
  )

  return { verdict, recording: everFed, sources, lastEventAt, checkedAt: now }
}
