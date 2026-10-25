// v0.8.0 A — Tailer host.
//
// Generic infrastructure for watching an AI coding agent's local transcript
// files, appending them to a hash-chained sidecar, and emitting per-turn
// audit events into RedLog's evidence log.
//
// Extracted from v0.7.6's `agent-transcript-tailer.ts` which had all the
// Claude-Code-specific parsing bolted directly onto the sidecar/insert-
// event/redaction/chokidar plumbing. This file OWNS the plumbing; the
// per-agent parsing is delegated to a `TailerAdapter` implementation
// registered via `registerAdapter()`. v0.8.0 C moves the Claude adapter
// into `plugins/claude-code-tailer/`; v0.8.1 adds Codex + OpenCode
// adapters against the same interface.
//
// **What lives here:**
// - chokidar dir-watch on each adapter's `transcriptGlob`
// - Sidecar, durable source checkpoints and privacy boundaries per project
// - Redaction on the way IN to the events table (via secret-redaction.ts)
// - `_causes` resolution — per-session `Map<transcriptUuid, redlogEventId>`
//   seeded at session-register time from the DB (v0.7.4 F2)
// - Pending-parent buffer (v0.7.5 G2) — cap 100, TTL 60s, flushes
//   recursively when a late parent arrives
// - Sensitive-path masking via sibling tool_call cache (v0.7.4 F1)
// - Snapshot event emission (idle + session-close)
// - Session lifecycle (register, unregister, chokidar unlink handling)
// - Pause gate (respects `eventBus.paused`, v0.7.3 A2 + v0.7.4 F4)
// - Self-exclusion via `.redlog-app-root` marker
//
// **What plugins do (via the TailerAdapter interface):**
// - Declare their `transcriptGlob` path pattern
// - Parse a single unit (a JSONL line or a whole per-message file — the
//   `perMessageDir` flag tells the host which)
// - Sniff cwd from the first unit(s) of a source
// - Optionally: signal file-reset detection (Claude's `/compact`)
// - Optionally: pick the command-shaped field from tool_input for sibling
//   cache (varies by agent — Bash puts it at `command`, file tools at
//   `file_path`, etc.)
// - Map their internal line type to a stable RedLog event subtype
//
// Every plugin MUST leave chain writes and file I/O to the host. Adapter
// code stays declarative + pure parsing; misbehaviour there produces
// wrong events, not chain corruption.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import chokidar, { FSWatcher } from 'chokidar'

import { ingestEvent } from '../../core/ingest'
import { extractTargetWithProvenance } from '../../core/target-extractor'
import { eventBus } from '../../core/event-bus'
import { getProjectDir, getDB } from '../../core/db/index'
import { noteDbError, noteCaptureError, clearCaptureError } from '../../core/capture-health'
import { redactSecrets, outputIfPathHiddenByCommand } from '../../core/secret-redaction'
import { isInsideDir } from '../../core/paths'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max bytes we keep in the events-table `full` field per turn. Anything
 *  larger is truncated with `truncated: true`; the sidecar still has the
 *  original. Chosen to match hook's opt-in `redlog-run` cap (v0.6.87 A2). */
const MAX_FULL_BYTES = 100 * 1024

/** v0.7.4 F1: cap per-session tool-command memoisation. In practice a
 *  session's outstanding tool_use → tool_result window is tiny (a few
 *  turns), but pathological Task-subagent runs could accumulate; LRU-evict
 *  keeps memory bounded regardless. */
const MAX_TOOL_CMD_CACHE = 1000

/** v0.7.5 G2: cap on the pending-parent buffer. */
const MAX_PENDING_CHILDREN = 100

/** v0.7.5 G2: how long a child can wait for its parent before we give up. */
const PENDING_TTL_MS = 60_000

// ─── Public interfaces ──────────────────────────────────────────────────────

/** Normalized per-turn shape every adapter produces. Fields are optional
 *  because different agents emit different metadata (Claude has thinking
 *  blocks + `_causes`; Codex has session_meta; OpenCode has file-message
 *  ordering). Host uses whatever it gets. */
export interface ParsedTurn {
  uuid: string | null
  parentUuid: string | null
  /** Adapter-internal type — mapped to a stable subtype via
   *  `adapter.subtypeFor(t)`. Common values: 'user' | 'assistant' |
   *  'tool_use' | 'tool_result' | 'tool_interrupted' | 'compact_summary'. */
  type: string
  role?: string
  isCompactSummary?: boolean
  isSidechain?: boolean
  model?: string
  version?: string
  gitBranch?: string
  promptId?: string
  permissionMode?: string
  usageTokensIn?: number
  usageTokensOut?: number
  textContent?: string
  toolName?: string
  toolUseId?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  hasThinking?: boolean
  /** Audit 2026-09-18 P2: wall-clock timestamp from the source transcript
   *  (e.g. Claude Code's `timestamp` field). Lets a reviewer correlate a
   *  turn with the agent's own timeline rather than relying solely on
   *  RedLog's insert-time `created_at`. */
  sourceTimestamp?: number
  // P2-3: model refusal / API error / permission decision metadata
  systemSubtype?: string
  refusalCategory?: string
  refusalExplanation?: string
  refusalDirection?: string
  originalModel?: string
  fallbackModel?: string
  errorType?: string
  errorMessage?: string
  toolDenialKind?: string
  toolResultRemedy?: string
  // P2-4: expanded token usage + response metadata
  stopReason?: string
  usageCacheCreation?: number
  usageCacheRead?: number
  usageThinkingTokens?: number
  serviceTier?: string
  imageBlockCount?: number
}

/** v0.8.3: control surface handed to `adapter.init(...)` so an adapter can
 *  inject turns from sources the host does not natively watch — a secondary
 *  chokidar tree (OpenCode's `storage/part/`), a WebSocket, a timer.
 *
 *  Turns injected via `emitTurns` run through the same dedup (`redlogIdByUuid`
 *  keyed on `turn.uuid`), redaction, and chain-linking as `parseUnit`-produced
 *  turns. Re-emitting a turn with an already-seen uuid is a safe no-op — this
 *  is the pattern for "poll the part/ dir every N seconds; adapter dedup
 *  covers repeated hits."
 *
 *  If no matching session is registered (msg stub not yet observed), the
 *  emit is dropped with an advisory. Adapter should therefore prefer to
 *  react to `add` events on files the host already watches, and use this
 *  surface only for supplemental streams. */
export interface HostControlSurface {
  acceptsMessage(agentKind: string, messageId: string, changedAt?: number): boolean
  emitTurns(agentKind: string, sessionId: string, turns: ParsedTurn[]): void
}

/** The plugin-facing contract. An adapter is a pure-parsing data structure
 *  with a handful of small callbacks — no I/O, no DB, no chain access.
 *  The host provides all side effects around it. */
export interface TailerAdapter {
  /** Stable identifier that lands in every emitted event's `data.agent`
   *  field. Namespace with hyphen: `claude-code`, `codex`, `opencode`. */
  agentKind: string
  /** Chokidar-watched pattern rooted at the adapter's home dir. May start
   *  with `~/` (host expands). Recursive globs (`**`) are honored. */
  transcriptGlob: string
  /** Literal built-in source root; never interpret directory names as globs. */
  transcriptRoot?: string
  /** True = each matching FILE is one unit (OpenCode's
   *  `~/.local/share/opencode/storage/message/*.json` layout).
   *  False (default) = each matching file is a JSONL stream, one unit per
   *  line (Claude Code, Codex CLI). */
  perMessageDir?: boolean
  /** Line types the adapter cares about — mapped to per-turn events via
   *  `subtypeFor`. Unrecognized types AND unknown-in-known-ignored types
   *  fire a one-shot `agent.transcript_schema_drift` advisory. */
  knownIngestTypes: Set<string>
  /** Line types the adapter recognises but deliberately skips (Claude's
   *  `custom-title`, `mode`, `queue-operation`, `last-prompt`, etc.). */
  knownIgnoredTypes: Set<string>
  /** Given a source file (JSONL for line-based, a directory or index file
   *  for per-message layouts), return the working directory the session
   *  was launched from — or null when nothing usable is present. Used to
   *  match against `excludedPaths` / `watchPaths` gates and to check the
   *  self-exclusion marker. */
  resolveCwd(sourcePath: string): string | null
  /** Parse one unit into a `ParsedTurn`, or null to skip. Adapter
   *  decides how to interpret its own `type` values — the host only
   *  routes on the eventual `subtypeFor(...)` string. `sourcePath` is
   *  the JSONL line's file (for JSONL adapters) or the per-message
   *  file itself (for per-message adapters); adapters that need to
   *  read sibling files (OpenCode's split `part/msg_<id>/` layout)
   *  use it to resolve the companion path. Line-based adapters that
   *  only look at `rawContent` can ignore it.
   *
   *  May return an ARRAY of turns for units that fan out into multiple
   *  audit events (OpenCode: one msg stub with N parts → text turn +
   *  tool_call turn + tool_result turn). The returned turns emit in
   *  order and each can carry its own `parentUuid` (adapter is
   *  responsible for wiring the intra-unit chain). */
  parseUnit(rawContent: string, sourcePath?: string): ParsedTurn | ParsedTurn[] | null
  /** Optional: adapter's own reset-detection. Default (used when omitted)
   *  is "source shrunk = reset" which handles Claude's `/compact` and
   *  Codex-style truncation. Return true to trigger sidecar reset. */
  detectReset?(oldSize: number, newSize: number): boolean
  /** Optional: pick the command-shaped string from tool_input so a later
   *  tool_result can gate its output against sensitive-path hints
   *  (`.ssh/`, `.env`, `.aws/`). Defaults to `input.command || input.file_path
   *  || input.path || input.url || input.query`. */
  pickCommandForCache?(toolName: string | undefined, input: Record<string, unknown>): string | null
  /** Map a ParsedTurn's adapter-internal `type` to a stable RedLog event
   *  subtype string. Common outputs: 'user_message', 'assistant_message',
   *  'tool_call', 'tool_result', 'compact_summary', 'thinking'. */
  subtypeFor(t: ParsedTurn): string
  /** v0.8.3: optional lifecycle hook, called once when the adapter is
   *  activated for an enabled source (never merely registered). Receives a control surface the adapter
   *  can use to emit supplemental turns from sources the host does not
   *  natively watch. Idempotent — the host guards against duplicate init
   *  calls on repeated registerAdapter. The host calls stop on disable/project switch so the adapter
   *  can tear down its auxiliary watchers. */
  init?(host: HostControlSurface): void
  stop?(): void
}

/** Host-level configuration shared across all registered adapters. */
export interface TailerHostConfig {
  enabled: boolean
  /** Which agents (`TailerAdapter.agentKind`) may be read. Unset means every
   *  registered adapter. An agent left out is never watched and a session path
   *  handed to `registerSession` is refused — checked before the self-exclusion
   *  and watch-path gates, so a disabled agent's files are not even opened. */
  enabledAgents?: readonly string[]
  engagementId: string
  operatorId: string
  /** File name that opts a repo out of tailing when found in any
   *  ancestor of the session's cwd. Default `.redlog-app-root` — RedLog's
   *  own repo commits one to break the "watching my own dev session"
   *  feedback loop. */
  selfExclusionMarker?: string
  idleFlushMs?: number
  previewChars?: number
  /** When true, `agent.thinking` events fire for adapters that surface
   *  thinking blocks (Claude Code). Off by default — content is large
   *  and mostly meta. */
  emitThinking?: boolean
  /** If a session's cwd matches any of these prefixes,
   *  tailing is skipped. */
  excludedPaths?: string[]
  /** Whitelist mode. When non-empty, ONLY sessions whose cwd matches one
   *  of these prefixes are tailed — everything else is dropped. */
  watchPaths?: string[]
  watchPathsByAgent?: Record<string, string[]>
  activationStarts?: Record<string, number>
  excludedSessionsByAgent?: Record<string, string[]>
  sessionStartsByAgent?: Record<string, Record<string, number>>
  /** v0.12.0: called after every `agent.tool_call` event insert with the
   *  extracted target host (if any). Feeds the alert subsystem's Scope
   *  policy so agent-driven scope violations register the same way shell
   *  and http ones do. Optional — if unset, agent tool calls skip the
   *  scope check (the event still lands in the chain). */
  scopeDispatch?: (input: {
    target: string
    source: 'agent_tool'
    action: string
    sourceEventId: string | null
  }) => void
}

// ─── Session state ──────────────────────────────────────────────────────────

interface SessionState {
  sessionId: string
  agentKind: string
  adapter: TailerAdapter
  sourcePath: string
  sourceBaseOffset: number
  sourceOffset: number
  discardPartial: boolean
  checkpointPaused: boolean
  pauseSkippedBytes: number
  resumedAt: number
  unitSidecarOffset: number
  replayFrom?: number
  completedFiles: Map<string, string>
  skipMissingParents: boolean
  ignoredParents: Map<string, string | null>
  sidecarPath: string
  transcriptCwd: string
  pendingLineBuffer: string
  redlogIdByUuid: Map<string, string>
  toolCommandByUseId: Map<string, string>
  pendingByParentUuid: Map<string, Array<{ turn: ParsedTurn; queuedAt: number; sidecarOffset: number }>>
  linesSeen: number
  turnsEmitted: number
  postCompact: boolean
  idleTimer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  retryAttempt: number
  lastSnapshotBytes: number
  bytesAppendedSinceSnapshot: number
  driftAdvisoryFired: Set<string>
  parentMissingAdvisoryFired: boolean
  toolCallsSeen: number
  toolCallsEmitted: number
  toolGapAdvisoryFired: boolean
  /** P1: incremental SHA-256 of the sidecar, updated on each append. */
  runningHash: crypto.Hash
  /** Lines skipped while recording was paused (reset on gap event emit). */
  pauseSkippedLines: number
  /** Timestamp when the first pause-skipped line was encountered. */
  pauseStartedAt: number | null
}

const registeredAdapters = new Map<string, TailerAdapter>()
let hostGeneration = 0
let cfg: TailerHostConfig = { enabled: false, engagementId: '', operatorId: '' }
const watchersByAgent = new Map<string, FSWatcher>()
// P2-5: write coalescing — rapid chokidar `change` events for the same
// session are debounced into a single catchUpSession call over a 50ms window.
const coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Keyed by `${agentKind}:${sessionId}` — two adapters can produce the same
 *  bare sessionId (e.g. Codex + Claude both name a session 'rollout-abc'). */
const sessions = new Map<string, SessionState>()

function sessionKey(agentKind: string, sessionId: string): string {
  return `${agentKind}:${sessionId}`
}

let resumeBoundary = 0
function boundaryPath(): string { return path.join(getProjectDir(), 'agent-transcripts', '.recording-boundary.json') }
function saveBoundary(paused: boolean): void {
  const file = boundaryPath(), tmp = file + '.tmp'
  let at = Date.now()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(tmp, JSON.stringify({ paused, at }), { mode: 0o600 })
    // Windows file timestamps can lead the coarser Date.now clock. Compare
    // source timestamps against a filesystem boundary too, or delayed discovery
    // can mistake paused content for a conversation created after resume.
    at = Math.max(at, Math.ceil(fs.statSync(tmp).mtimeMs))
    fs.writeFileSync(tmp, JSON.stringify({ paused, at }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  catch (e) { try { fs.unlinkSync(tmp) } catch { /* staging metadata only */ }; throw e }
  resumeBoundary = at
}
function restoreBoundary(): void {
  resumeBoundary = 0
  const file = boundaryPath()
  if (!fs.existsSync(file)) return
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Number.isSafeInteger(value.at) || value.at <= 0 || typeof value.paused !== 'boolean') throw new Error('Invalid AI recording boundary')
  resumeBoundary = value.at
  if (value.paused && !eventBus.paused) saveBoundary(false)
}

const COALESCE_MS = 50
const RETRY_BASE_MS = 1000
const RETRY_LIMIT = 5

/** A failed pass is read again on the next file event or restart. The last
 *  turn of a session gets neither, so a few backed-off passes cover it; after
 *  those it waits for the same two things, with the error in capture health. */
function scheduleRetry(s: SessionState): void {
  if (s.retryTimer || s.retryAttempt >= RETRY_LIMIT) return
  s.retryTimer = setTimeout(() => { s.retryTimer = null; catchUpSession(s.agentKind, s.sessionId) }, RETRY_BASE_MS * 2 ** s.retryAttempt++)
  s.retryTimer.unref?.()
}

function coalescedCatchUp(agentKind: string, sid: string): void {
  const key = sessionKey(agentKind, sid)
  const existing = coalesceTimers.get(key)
  if (existing) clearTimeout(existing)
  coalesceTimers.set(key, setTimeout(() => {
    coalesceTimers.delete(key)
    if (sessions.has(key)) catchUpSession(agentKind, sid)
  }, COALESCE_MS))
}

// ─── Session ID registry (Hybrid D Phase 1) ────────────────────────────────
//
// When the registry is empty (no skill / MCP call has registered a session),
// ALL sessions pass until a session is explicitly selected. Once any session registers, ONLY
// registered session IDs are captured. This gives the operator session-level
// precision while keeping automatic discovery useful by default.

const sessionRegistry = new Set<string>()

export function registerSessionId(sessionId: string): void {
  sessionRegistry.add(sessionId)
}

export function isSessionRegistered(sessionId: string): boolean {
  return sessionRegistry.size === 0 || sessionRegistry.has(sessionId)
}

export function getRegisteredSessions(): string[] {
  return [...sessionRegistry]
}

export interface AgentSessionInfo { agentKind: string; sessionId: string; cwd?: string; recording: boolean }
export function listAgentSessions(): AgentSessionInfo[] {
  const result = [...sessions.values()].map(s => ({ agentKind: s.agentKind, sessionId: s.sessionId, cwd: s.transcriptCwd, recording: cfg.enabled && !eventBus.paused })) as AgentSessionInfo[]
  for (const [agentKind, ids] of Object.entries(cfg.excludedSessionsByAgent ?? {})) for (const sessionId of ids) {
    if (!result.some(s => s.agentKind === agentKind && s.sessionId === sessionId)) result.push({ agentKind, sessionId, recording: false })
  }
  return result
}
function sessionAllowed(kind: string, id: string): boolean {
  return isSessionRegistered(id) && !cfg.excludedSessionsByAgent?.[kind]?.includes(id)
}
function activationFor(kind: string, id: string): number | undefined {
  return Math.max(cfg.sessionStartsByAgent?.[kind]?.[id] ?? 0, cfg.activationStarts?.[kind] ?? 0) || undefined
}

// ─── Adapter registry ───────────────────────────────────────────────────────

const initializedAdapters = new Set<string>()

const hostControlSurface: HostControlSurface = {
  acceptsMessage(agentKind, messageId, changedAt) {
    if (eventBus.paused || !cfg.enabled || !agentEnabled(agentKind) || !/^[a-zA-Z0-9_-]+$/.test(messageId)) return false
    return [...sessions.values()].some(s => s.agentKind === agentKind && sessionAllowed(agentKind, s.sessionId) && s.adapter.perMessageDir && s.redlogIdByUuid.get(messageId + '.json') !== '__paused__' && (changedAt === undefined || changedAt >= s.resumedAt + 1) && fs.existsSync(path.join(s.sourcePath, messageId + '.json')))
  },
  emitTurns(agentKind: string, sessionId: string, turns: ParsedTurn[]): void {
    if (eventBus.paused) return
    const s = sessions.get(sessionKey(agentKind, sessionId))
    if (!s || !sessionAllowed(agentKind, sessionId)) {
      // No live session — the msg stub for this sessionId hasn't been
      // observed yet. Drop silently; the adapter is expected to retry (or
      // the primary watcher will pick up the session soon).
      return
    }
    for (const turn of turns) {
      if (!s.adapter.knownIngestTypes.has(turn.type)) continue
      try { emitTurn(turn, { session: s }) } catch (e) { noteDbError('tailer-host', e) }
    }
  }
}

function agentEnabled(agentKind: string): boolean {
  return !cfg.enabledAgents || cfg.enabledAgents.includes(agentKind)
}

export function registerAdapter(adapter: TailerAdapter): void {
  registeredAdapters.set(adapter.agentKind, adapter)
  // If already running, start a watcher for this adapter immediately so
  // late registrations (e.g. plugin loaded after project open) don't miss
  // active sessions. Idempotent — `restart` also handles this.
  if (cfg.enabled && cfg.engagementId && cfg.operatorId) restartAdapter(adapter)
}

export function unregisterAdapter(agentKind: string): void {
  const w = watchersByAgent.get(agentKind)
  if (w) { void w.close(); watchersByAgent.delete(agentKind) }
  // Also close any sessions that belong to this adapter.
  for (const [key, s] of sessions) if (s.agentKind === agentKind) unregisterSession(key)
  if (initializedAdapters.has(agentKind)) registeredAdapters.get(agentKind)?.stop?.()
  registeredAdapters.delete(agentKind)
  initializedAdapters.delete(agentKind)
}

// ─── Path + gate helpers (adapter-agnostic) ─────────────────────────────────

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

/** Walk up from `cwd` looking for the self-exclusion marker file. */
export function isSelfExcludedCwd(cwd: string, marker: string): boolean {
  if (!cwd) return false
  let cur = path.resolve(cwd)
  const seen = new Set<string>()
  while (!seen.has(cur)) {
    seen.add(cur)
    try {
      if (fs.existsSync(path.join(cur, marker))) return true
    } catch { /* ignore */ }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

export function cwdPassesGate(cwd: string, excludedPaths?: string[], watchPaths?: string[]): boolean {
  const normalize = (p: string): string => {
    const resolved = path.resolve(expandTilde(p))
    try { return fs.realpathSync(resolved).replace(/[\\/]$/, '') } catch { return resolved.replace(/[\\/]$/, '') }
  }
  const cwdNorm = normalize(cwd)
  if (excludedPaths && excludedPaths.length) {
    for (const raw of excludedPaths) {
      if (!raw) continue
      const ex = normalize(raw)
      if (cwdNorm === ex || cwdNorm.startsWith(ex + path.sep)) return false
    }
  }
  if (watchPaths && watchPaths.length) {
    let matched = false
    for (const raw of watchPaths) {
      if (!raw) continue
      const wp = normalize(raw)
      if (cwdNorm === wp || cwdNorm.startsWith(wp + path.sep)) { matched = true; break }
    }
    if (!matched) return false
  }
  return true
}

// ─── Redaction + cache helpers ──────────────────────────────────────────────

/** Deep-walk any JSON-shaped value; redact every string leaf via
 *  `redactSecrets`. Cycle-safe. */
export function deepRedactStrings(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[cyclic]'
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => deepRedactStrings(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepRedactStrings(v, seen)
  }
  return out
}

// v0.12.2: per-tool "which top-level fields need scanning" allowlist. Before
// this, tool_call events ran deepRedactStrings over the ENTIRE tool_input
// tree — including `Read`'s numeric `offset`/`limit` and `file_path` (path
// strings never contain the secrets redactSecrets matches). The map below
// covers the Claude Code + OpenCode + Codex tool names we ingest today; a
// tool not in the map falls back to scanning EVERY string field (safe
// default). This is the "known-safe fields" shape from the audit — the tree
// walk still happens for arrays / nested objects on the listed fields, so a
// `content` field that's an object gets recursed as before.
const TOOL_INPUT_SCAN_FIELDS: Record<string, Set<string>> = {
  // Claude Code tools
  Bash: new Set(['command']),
  Read: new Set([]),                // file_path + offset + limit — all metadata
  Write: new Set(['content']),
  Edit: new Set(['old_string', 'new_string']),
  Grep: new Set(['pattern']),
  Glob: new Set([]),                // pattern is a glob, not free-text
  WebFetch: new Set(['prompt', 'url']),
  WebSearch: new Set(['query']),
  Task: new Set(['prompt', 'description']),
  // OpenCode / Codex tools (best-effort; unknown tools scan-all so we're
  // fine here — this list is an optimisation, not a correctness gate)
  bash: new Set(['command']),
  read: new Set([]),
  write: new Set(['content']),
  edit: new Set(['old_string', 'new_string'])
}

/** Redact tool_input using the per-tool allowlist when known; fall back to
 *  full-tree scan for unknown tools. Called from the tool_call emit path. */
export function redactToolInput(
  toolName: string | undefined,
  input: Record<string, unknown>
): Record<string, unknown> {
  const fields = toolName ? TOOL_INPUT_SCAN_FIELDS[toolName] : undefined
  if (fields === undefined) {
    // Unknown tool — safe default is full-tree scan.
    return deepRedactStrings(input) as Record<string, unknown>
  }
  if (fields.size === 0) {
    // Known-clean tool (Read, Glob): every field is metadata. Return
    // shallow copy so downstream mutations don't touch the adapter's
    // parsed turn.
    return { ...input }
  }
  // Scan only the listed fields; carry everything else through.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = fields.has(k) ? deepRedactStrings(v) : v
  }
  return out
}

function defaultPickCommandForCache(_toolName: string | undefined, input: Record<string, unknown>): string | null {
  const priority = ['command', 'file_path', 'path', 'url', 'query']
  for (const k of priority) {
    const v = input[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** v0.12.0: pull a host out of a tool_input's picked string. URLs get their
 *  hostname; anything shell-command-shaped goes through the same target
 *  extractor the shell lane uses (`curl example.com`, `nmap 10.0.0.5`, …).
 *  Returns null when nothing plausibly host-shaped shows up — file paths
 *  and free-text prompts should NOT trigger a scope check. */
function extractTargetFromToolInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // A picked `url` field is already a URL; parse rather than shell-lex it.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      return u.hostname || null
    } catch { return null }
  }
  // File paths shouldn't route through the shell extractor either — an
  // absolute path just happens to start with a slash that the extractor's
  // heuristics don't want.
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return null
  return extractTargetWithProvenance(trimmed).host
}

// ─── Emit ───────────────────────────────────────────────────────────────────

interface EmitContext {
  session: SessionState
  /** Set when flushing orphaned pending-parent turns so they emit without
   *  _causes instead of being re-buffered. */
  _skipParentBuffer?: boolean
}

function emitTurn(t: ParsedTurn, ctx: EmitContext): void {
  if (!t.uuid) return
  const s = ctx.session
  // A re-read parent still flushes: children whose write failed wait here.
  if (s.redlogIdByUuid.has(t.uuid)) { flushWaiting(s, t.uuid, ctx); return }

  let parentUuid = t.parentUuid
  const parentPath = new Set<string>()
  while (parentUuid && s.ignoredParents.has(parentUuid)) {
    if (parentPath.has(parentUuid)) { parentUuid = null; break }
    parentPath.add(parentUuid); parentUuid = s.ignoredParents.get(parentUuid) ?? null
  }
  // v0.7.5 G2: pending-parent buffer. Adapter guarantees ordering only
  // within a JSONL file; Claude Code has been observed writing children
  // before parents in ~0.09% of turns. Buffer them; flush recursively
  // when the parent lands.
  let causesArr: string[] | undefined
  if (parentUuid && !ctx._skipParentBuffer && (!s.skipMissingParents || s.redlogIdByUuid.has(parentUuid))) {
    const parentRid = s.redlogIdByUuid.get(parentUuid)
    if (parentRid) {
      causesArr = [parentRid]
    } else {
      const orphans = sweepStalePending(s)
      // Emit orphaned turns that waited past TTL — they go out without
      // _causes rather than being silently dropped.
      for (const ot of orphans) {
        if (!ot.uuid || s.redlogIdByUuid.has(ot.uuid)) continue
        emitTurn(ot, { ...ctx, _skipParentBuffer: true })
      }
      const queue = s.pendingByParentUuid.get(parentUuid) ?? []
      // A failed pass is read again; its children are already waiting.
      if (queue.some(q => q.turn.uuid === t.uuid)) return
      if (queue.length + pendingSize(s) < MAX_PENDING_CHILDREN) {
        queue.push({ turn: t, queuedAt: Date.now(), sidecarOffset: s.unitSidecarOffset })
        s.pendingByParentUuid.set(parentUuid, queue)
        return
      }
      if (!s.parentMissingAdvisoryFired) {
        s.parentMissingAdvisoryFired = true
        try {
          const ev = ingestEvent('agent', {
            subtype: 'transcript_parent_missing',
            session_id: s.sessionId,
            agent: s.agentKind,
            parent_uuid: parentUuid,
            child_uuid: t.uuid,
            child_type: t.type,
            pending_full: true,
            description: `Pending-parent buffer full (>${MAX_PENDING_CHILDREN}). Later children with missing parents emit without _causes rather than deferring indefinitely.`
          }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
        } catch (e) { noteDbError('tailer-host', e) }
      }
    }
  }

  const subtype = s.adapter.subtypeFor(t)
  if (subtype === 'thinking' && !cfg.emitThinking) return

  const preview = t.textContent
    ? redactSecrets(t.textContent).slice(0, cfg.previewChars ?? 500)
    : undefined

  const data: Record<string, unknown> = {
    subtype,
    agent: s.agentKind,
    session_id: s.sessionId,
    transcript_uuid: t.uuid,
    ...(t.parentUuid ? { transcript_parent_uuid: t.parentUuid } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.version ? { agent_version: t.version } : {}),
    ...(t.gitBranch ? { git_branch: t.gitBranch } : {}),
    ...(t.promptId ? { prompt_id: t.promptId } : {}),
    ...(t.permissionMode ? { permission_mode: t.permissionMode } : {}),
    ...(t.isSidechain ? { is_sidechain: true } : {}),
    ...(s.postCompact ? { post_compact: true } : {}),
    ...(typeof t.usageTokensIn === 'number' ? { usage_tokens_in: t.usageTokensIn } : {}),
    ...(typeof t.usageTokensOut === 'number' ? { usage_tokens_out: t.usageTokensOut } : {}),
    ...(typeof t.usageCacheCreation === 'number' ? { usage_cache_creation: t.usageCacheCreation } : {}),
    ...(typeof t.usageCacheRead === 'number' ? { usage_cache_read: t.usageCacheRead } : {}),
    ...(typeof t.usageThinkingTokens === 'number' ? { usage_thinking_tokens: t.usageThinkingTokens } : {}),
    ...(t.serviceTier ? { service_tier: t.serviceTier } : {}),
    ...(t.stopReason ? { stop_reason: t.stopReason } : {}),
    ...(typeof t.imageBlockCount === 'number' ? { image_block_count: t.imageBlockCount } : {}),
    ...(typeof t.sourceTimestamp === 'number' ? { source_timestamp: t.sourceTimestamp } : {}),
    ...(t.refusalCategory ? { refusal_category: t.refusalCategory } : {}),
    ...(t.refusalExplanation ? { refusal_explanation: t.refusalExplanation } : {}),
    ...(t.refusalDirection ? { refusal_direction: t.refusalDirection } : {}),
    ...(t.originalModel ? { original_model: t.originalModel } : {}),
    ...(t.fallbackModel ? { fallback_model: t.fallbackModel } : {}),
    ...(t.errorType ? { error_type: t.errorType } : {}),
    ...(t.errorMessage ? { error_message: t.errorMessage } : {}),
    ...(t.toolDenialKind ? { tool_denial_kind: t.toolDenialKind } : {}),
    ...(t.toolResultRemedy ? { tool_result_remedy: t.toolResultRemedy } : {}),
    ...(causesArr ? { _causes: causesArr } : {})
  }

  if (subtype === 'user_message' || subtype === 'assistant_message') {
    if (preview !== undefined) data.preview = preview
    if (t.textContent !== undefined) {
      data.full_length = t.textContent.length
      const redFull = redactSecrets(t.textContent)
      if (Buffer.byteLength(redFull, 'utf-8') > MAX_FULL_BYTES) {
        data.full = redFull.slice(0, Math.floor(MAX_FULL_BYTES / 2))
        data.truncated = true
      } else {
        data.full = redFull
      }
    }
    if (t.hasThinking) data.has_thinking = true
  } else if (subtype === 'tool_call') {
    if (t.toolName) data.tool_name = t.toolName
    if (t.toolUseId) data.tool_use_id = t.toolUseId
    if (t.toolInput) {
      // v0.12.2: per-tool scan allowlist skips the full-tree walk for
      // tools whose input is all metadata (Read, Glob) or has a small
      // known-freetext field set (Bash → command only). Unknown tools
      // fall back to the full-tree walk.
      const redInput = redactToolInput(t.toolName, t.toolInput)
      const inputJson = JSON.stringify(redInput)
      if (Buffer.byteLength(inputJson, 'utf-8') > MAX_FULL_BYTES) {
        data.tool_input_truncated = true
        data.tool_input_length = inputJson.length
        data.tool_input = { _truncated: true, keys: Object.keys(redInput) }
      } else {
        data.tool_input = redInput
      }
      if (t.toolUseId) {
        const picker = s.adapter.pickCommandForCache ?? defaultPickCommandForCache
        const cmd = picker(t.toolName, t.toolInput)
        if (cmd) {
          if (s.toolCommandByUseId.has(t.toolUseId)) s.toolCommandByUseId.delete(t.toolUseId)
          s.toolCommandByUseId.set(t.toolUseId, cmd)
          while (s.toolCommandByUseId.size > MAX_TOOL_CMD_CACHE) {
            const oldest = s.toolCommandByUseId.keys().next().value
            if (oldest === undefined) break
            s.toolCommandByUseId.delete(oldest)
          }
        }
      }
      if (t.toolName && t.toolName.startsWith('mcp__')) {
        const parts = t.toolName.split('__')
        if (parts.length >= 3) data.mcp_server = parts[1]
      }
    }
  } else if (subtype === 'tool_result') {
    if (t.toolUseId) data.tool_use_id = t.toolUseId
    if (t.toolOutput !== undefined) {
      let output = redactSecrets(t.toolOutput)
      if (t.toolUseId) {
        const cmd = s.toolCommandByUseId.get(t.toolUseId)
        if (cmd) output = outputIfPathHiddenByCommand(cmd, output)
        else output = outputIfPathHiddenByCommand(output, output)
      }
      data.output_length = t.toolOutput.length
      if (Buffer.byteLength(output, 'utf-8') > MAX_FULL_BYTES) {
        data.output = output.slice(0, MAX_FULL_BYTES)
        data.truncated = true
      } else {
        data.output = output
      }
    }
  } else if (subtype === 'thinking') {
    if (preview !== undefined) data.preview = preview
    if (t.textContent !== undefined) data.full_length = t.textContent.length
  } else if (subtype === 'tool_interrupted' || subtype === 'away_summary') {
    if (preview !== undefined) data.preview = preview
  } else if (subtype === 'model_refusal' || subtype === 'api_error') {
    if (t.systemSubtype) data.system_subtype = t.systemSubtype
  }

  try {
    const ev = ingestEvent('agent', data, {
      engagementId: cfg.engagementId,
      operatorId: cfg.operatorId
    })
    if (!ev) throw new Error('AI event was not saved')
    if (ev) {
      s.redlogIdByUuid.set(t.uuid, ev.id)
      s.turnsEmitted++
      if (subtype === 'tool_call') s.toolCallsEmitted++
      // v0.12.0: hand tool_call events to the alert subsystem so agent-
      // driven activity registers in the Scope report the same way shell
      // and http do. Extraction uses the same picker as the sensitive-
      // path cache — command/url/file_path/path/query, first hit wins.
      if (subtype === 'tool_call' && cfg.scopeDispatch && t.toolInput) {
        const picker = s.adapter.pickCommandForCache ?? defaultPickCommandForCache
        const raw = picker(t.toolName, t.toolInput)
        if (raw) {
          const target = extractTargetFromToolInput(raw)
          if (target) {
            cfg.scopeDispatch({
              target,
              source: 'agent_tool',
              action: `${t.toolName ?? 'tool'} ${raw}`.slice(0, 200),
              sourceEventId: ev.id
            })
          }
        }
      }
      flushWaiting(s, t.uuid, ctx)
    }
  } catch (e) { noteDbError('tailer-host', e); throw e }
}

/** Children leave the queue only once written. Their own lines are already
 *  committed, so a child dropped on a failed write would never be read again. */
function flushWaiting(s: SessionState, parentUuid: string, ctx: EmitContext): void {
  const waiting = s.pendingByParentUuid.get(parentUuid)
  if (!waiting) return
  s.pendingByParentUuid.delete(parentUuid)
  for (let i = 0; i < waiting.length; i++) {
    try { emitTurn(waiting[i].turn, ctx) } catch (e) { s.pendingByParentUuid.set(parentUuid, waiting.slice(i)); throw e }
  }
}

function sweepStalePending(s: SessionState): ParsedTurn[] {
  const cutoff = Date.now() - PENDING_TTL_MS
  const orphans: ParsedTurn[] = []
  for (const [parentUuid, queue] of s.pendingByParentUuid) {
    const alive = queue.filter((q) => q.queuedAt >= cutoff)
    for (const q of queue) {
      if (q.queuedAt < cutoff) orphans.push(q.turn)
    }
    if (alive.length === 0) s.pendingByParentUuid.delete(parentUuid)
    else if (alive.length !== queue.length) s.pendingByParentUuid.set(parentUuid, alive)
  }
  return orphans
}

function pendingSize(s: SessionState): number {
  let n = 0
  for (const queue of s.pendingByParentUuid.values()) n += queue.length
  return n
}

// ─── Ingest loop ────────────────────────────────────────────────────────────

/** Catch a session up from its committed source offset to the current size.
 *  Handles both per-line (JSONL) and per-message (file-per-unit) adapters
 *  based on `adapter.perMessageDir`. Public for testability. */
export function catchUpSession(agentKind: string, sessionId: string): void {
  const s = sessions.get(sessionKey(agentKind, sessionId))
  if (!s || !sessionAllowed(agentKind, sessionId)) return
  if (s.adapter.perMessageDir) {
    catchUpPerMessageDir(s)
  } else {
    catchUpJsonl(s)
  }
}

function checkpoint(s: SessionState, offset = s.sourceOffset, savedBytes?: number): void {
  const bytes = savedBytes ?? (fs.existsSync(s.sidecarPath) ? fs.statSync(s.sidecarPath).size : 0)
  const file = s.sidecarPath + '.offset.json'
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify({ source: s.sourcePath, startedAt: activationFor(s.agentKind, s.sessionId), base: s.sourceBaseOffset,
      offset, savedBytes: bytes, discardPartial: s.discardPartial, paused: s.checkpointPaused,
      skippedBytes: s.pauseSkippedBytes, gapStartedAt: s.pauseStartedAt, resumedAt: s.resumedAt, skipMissingParents: s.skipMissingParents,
      ignoredParents: Object.fromEntries(s.ignoredParents),
      replayFrom: s.adapter.perMessageDir || !s.pendingByParentUuid.size ? undefined : Math.min(...[...s.pendingByParentUuid.values()].flat().map(q => q.sidecarOffset)) }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (e) { try { fs.unlinkSync(tmp) } catch { /* only our staging file */ }; throw e }
}

/** Boundaries are metadata only: never append paused source bytes to evidence. */
function discardJsonl(s: SessionState): void {
  const size = fs.statSync(s.sourcePath).size
  if (size !== s.sourceOffset) {
    s.pauseSkippedBytes += Math.max(0, size - s.sourceOffset)
    s.pauseStartedAt ??= Date.now()
    s.discardPartial = false
    if (size > 0) {
      const fd = fs.openSync(s.sourcePath, 'r')
      try { const tail = Buffer.alloc(1); fs.readSync(fd, tail, 0, 1, size - 1); s.discardPartial = tail[0] !== 10 }
      finally { fs.closeSync(fd) }
    }
  }
  s.pendingLineBuffer = ''
  s.pendingByParentUuid.clear()
  s.skipMissingParents = true
  s.toolCommandByUseId.clear()
  s.ignoredParents.clear()
  checkpoint(s, size)
  s.sourceOffset = size
}

function reportGap(s: SessionState): void {
  if (!s.pauseSkippedBytes && !s.pauseSkippedLines) return
  const ev = ingestEvent('system', { subtype: 'capture_gap', agent: s.agentKind, session_id: s.sessionId,
    skipped_bytes: s.pauseSkippedBytes, skipped_units: s.pauseSkippedLines,
    gap_started_at: s.pauseStartedAt, gap_ended_at: Date.now(),
    description: 'Recording paused: source content omitted from events and sidecar.'
  }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
  if (!ev) throw new Error('AI capture gap was not saved')
  s.pauseSkippedBytes = 0; s.pauseSkippedLines = 0; s.pauseStartedAt = null
}

function appendAndCommit(s: SessionState, bytes: Buffer, offset: number): void {
  const before = fs.existsSync(s.sidecarPath) ? fs.statSync(s.sidecarPath).size : 0
  try {
    fs.appendFileSync(s.sidecarPath, bytes, { mode: 0o600 })
    checkpoint(s, offset, before + bytes.length)
  } catch (e) {
    // A short write or a failed checkpoint cannot leave an advanced raw cursor.
    if (fs.existsSync(s.sidecarPath)) fs.truncateSync(s.sidecarPath, before)
    throw e
  }
  s.sourceOffset = offset
  s.runningHash.update(bytes)
  s.bytesAppendedSinceSnapshot += bytes.length
  clearCaptureError(`agent-${s.agentKind}`)
}

function catchUpJsonl(s: SessionState): void {
  if (!cfg.enabled || sessions.get(sessionKey(s.agentKind, s.sessionId)) !== s) return
  try {
    if (eventBus.paused || s.checkpointPaused) {
      // Also recover a shutdown/crash during a persisted pause without replay.
      discardJsonl(s)
      if (eventBus.paused) return
      s.checkpointPaused = false; checkpoint(s)
    }
    const sourceSize = fs.statSync(s.sourcePath).size
    if (s.adapter.detectReset?.(s.sourceOffset, sourceSize) ?? (sourceSize < s.sourceOffset)) {
      const size = fs.existsSync(s.sidecarPath) ? fs.statSync(s.sidecarPath).size : 0
      // Keep prior evidence append-only; a reset never truncates recorded bytes.
      const ev = ingestEvent('agent', { subtype: 'transcript_compacted', agent: s.agentKind, session_id: s.sessionId,
        old_sidecar_bytes: size, old_sidecar_sha256: fileSha256(s.sidecarPath), new_source_bytes: sourceSize
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      if (!ev) throw new Error('AI reset was not saved')
      s.discardPartial = false; checkpoint(s, 0); s.sourceOffset = 0
      s.pendingByParentUuid.clear(); s.pendingLineBuffer = ''; s.postCompact = true
      s.ignoredParents.clear(); s.toolCommandByUseId.clear(); s.skipMissingParents = true
    }
    if (sourceSize <= s.sourceOffset) return
    const limit = Math.min(sourceSize - s.sourceOffset, 10 * 1024 * 1024)
    const fd = fs.openSync(s.sourcePath, 'r')
    let bytes: Buffer
    try { bytes = Buffer.alloc(limit); const read = fs.readSync(fd, bytes, 0, limit, s.sourceOffset); bytes = bytes.subarray(0, read) }
    finally { fs.closeSync(fd) }
    if (s.discardPartial) {
      const end = bytes.indexOf(10)
      const skip = end < 0 ? bytes.length : end + 1
      const previous = s.discardPartial
      s.discardPartial = end < 0
      try { checkpoint(s, s.sourceOffset + skip) } catch (e) { s.discardPartial = previous; throw e }
      s.sourceOffset += skip; bytes = bytes.subarray(skip)
    }
    const lastNl = bytes.lastIndexOf(10)
    if (lastNl < 0) {
      if (bytes.length === 10 * 1024 * 1024) throw new Error('AI transcript unit exceeds the 10 MB read limit')
      return
    }
    const complete = bytes.subarray(0, lastNl + 1)
    reportGap(s)
    // Preserve partial UTF-8 bytes at the source; decode only complete lines.
    s.unitSidecarOffset = fs.existsSync(s.sidecarPath) ? fs.statSync(s.sidecarPath).size : 0
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.trim()) processUnit(s, line.replace(/\r$/, ''), s.sourcePath)
      s.unitSidecarOffset += Buffer.byteLength(line + '\n')
    }
    appendAndCommit(s, complete, s.sourceOffset + complete.length)
    s.linesSeen += complete.toString('utf8').split('\n').filter(line => line.trim()).length
    scheduleIdleSnapshot(s)
    s.retryAttempt = 0
    if (sourceSize - s.sourceOffset > complete.length && limit === 10 * 1024 * 1024) setImmediate(() => catchUpJsonl(s))
  } catch (e) { noteCaptureError(`agent-${s.agentKind}`, e); scheduleRetry(s) }
}

function catchUpPerMessageDir(s: SessionState): void {
  if (!cfg.enabled || sessions.get(sessionKey(s.agentKind, s.sessionId)) !== s) return
  try {
    const units = fs.readdirSync(s.sourcePath).filter(name => name.endsWith('.json')).map(name => ({ name, full: path.join(s.sourcePath, name) }))
      .map(p => ({ ...p, stat: fs.statSync(p.full) })).filter(p => p.stat.isFile() && p.stat.mtimeMs >= (activationFor(s.agentKind, s.sessionId) ?? 0))
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name))
    for (const p of units) {
      if (s.redlogIdByUuid.get(p.name) === '__paused__') continue
      if (eventBus.paused || s.checkpointPaused || (resumeBoundary > 0 && p.stat.mtimeMs < resumeBoundary + 1)) {
        // Names only, no message/part content. Persist exclusions across restart.
        appendAndCommit(s, Buffer.from('!pause:' + p.name + '\n'), s.sourceOffset)
        s.redlogIdByUuid.set(p.name, '__paused__'); s.pauseSkippedLines++; s.pauseStartedAt ??= Date.now()
        continue
      }
      const fingerprint = `${p.stat.mtimeMs}:${p.stat.size}`
      if (s.completedFiles.get(p.name) === fingerprint) continue
      reportGap(s)
      processUnit(s, fs.readFileSync(p.full, 'utf8'), p.full)
      if (!s.redlogIdByUuid.has(p.name)) appendAndCommit(s, Buffer.from(p.name + '\n'), s.sourceOffset)
      s.redlogIdByUuid.set(p.name, '__seen__'); s.completedFiles.set(p.name, fingerprint); s.linesSeen++
    }
    if (!eventBus.paused && s.checkpointPaused) { s.checkpointPaused = false; checkpoint(s) }
    if (!eventBus.paused) scheduleIdleSnapshot(s)
    s.retryAttempt = 0
  } catch (e) { noteCaptureError(`agent-${s.agentKind}`, e); scheduleRetry(s) }
}

// Synchronous resume boundary precedes any delayed watcher callback. Empty
// sessions/new files are registered by normal discovery and use the same gate.
const onRecording = (recording: boolean): void => {
  if (!cfg.enabled) return
  try { saveBoundary(!recording) } catch (e) { for (const kind of cfg.enabledAgents ?? registeredAdapters.keys()) noteCaptureError(`agent-${kind}`, e); cfg.enabled = false; return }
  for (const s of sessions.values()) {
    try {
      s.checkpointPaused = true
      if (s.adapter.perMessageDir) catchUpPerMessageDir(s)
      else discardJsonl(s)
      s.resumedAt = resumeBoundary; s.skipMissingParents = true
      if (recording) { s.checkpointPaused = false; checkpoint(s) }
    } catch (e) { noteCaptureError(`agent-${s.agentKind}`, e) }
  }
}
eventBus.on('recording', onRecording)

function processUnit(s: SessionState, rawContent: string, sourcePath: string): void {
  let raw: ParsedTurn | ParsedTurn[] | null
  try {
    raw = s.adapter.parseUnit(rawContent, sourcePath)
  } catch (e) {
    // Adapter blew up on a single unit — count it as schema drift, don't
    // crash the whole session's ingest.
    if (!s.driftAdvisoryFired.has('<parse_error>')) {
      s.driftAdvisoryFired.add('<parse_error>')
      try {
        const ev = ingestEvent('agent', {
          subtype: 'transcript_schema_drift',
          session_id: s.sessionId,
          agent: s.agentKind,
          unknown_type: '<parse_error>',
          description: 'Adapter.parseUnit() threw. See stderr for details.'
        }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      } catch (err) { noteDbError('tailer-host', err) }
    }
    noteCaptureError(`agent-${s.agentKind}`, e)
    throw e
  }
  if (!raw) return
  const turns = Array.isArray(raw) ? raw : [raw]
  // A failed unit is read again, so its count must not stick.
  const toolCallsSeen = s.toolCallsSeen
  try { processTurns(s, turns) } catch (e) { s.toolCallsSeen = toolCallsSeen; throw e }
}

function processTurns(s: SessionState, turns: ParsedTurn[]): void {
  for (const turn of turns) {
    if (s.adapter.knownIgnoredTypes.has(turn.type)) {
      if (turn.uuid) s.ignoredParents.set(turn.uuid, turn.parentUuid)
      continue
    }
    // Schema-drift check: parseUnit returned a turn whose type isn't in the
    // adapter's whitelist. Fire the advisory once per session and skip.
    if (turn.type === 'tool_use' && !(turn.uuid && s.redlogIdByUuid.has(turn.uuid))) s.toolCallsSeen++
    if (!s.adapter.knownIngestTypes.has(turn.type)) {
      if (!s.driftAdvisoryFired.has(turn.type)) {
        s.driftAdvisoryFired.add(turn.type)
        const safeType = String(turn.type).slice(0, 100).replace(/[\x00-\x1f]/g, '')
        try {
          const ev = ingestEvent('agent', {
            subtype: 'transcript_schema_drift',
            session_id: s.sessionId,
            agent: s.agentKind,
            unknown_type: safeType,
            description: `Encountered a transcript line type not in the adapter whitelist. Skipping only this type.`
          }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
        } catch (e) { noteDbError('tailer-host', e) }
      }
      continue
    }
    emitTurn(turn, { session: s })
  }
}

function scheduleIdleSnapshot(s: SessionState): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null
    emitSnapshot(s, 'idle')
  }, cfg.idleFlushMs ?? 15_000)
}

function emitSnapshot(s: SessionState, reason: 'idle' | 'session_close' | 'periodic'): void {
  if (eventBus.paused) return
  if (s.bytesAppendedSinceSnapshot === 0 && reason === 'idle') return
  let sidecarSize = 0
  try { sidecarSize = fs.statSync(s.sidecarPath).size } catch { return }
  const sha = s.runningHash.copy().digest('hex')
  try {
    const ev = ingestEvent('agent', {
      subtype: 'transcript_snapshot',
      session_id: s.sessionId,
      agent: s.agentKind,
      snapshot_path: s.sidecarPath,
      cumulative_bytes: sidecarSize,
      cumulative_sha256: sha,
      line_count: s.linesSeen,
      turns_emitted: s.turnsEmitted,
      tool_calls_seen: s.toolCallsSeen,
      tool_calls_emitted: s.toolCallsEmitted,
      reason
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
  } catch (e) { noteDbError('tailer-host', e) }

  if (!s.toolGapAdvisoryFired && s.toolCallsSeen >= 10 && s.toolCallsEmitted === 0) {
    s.toolGapAdvisoryFired = true
    try {
      const ev = ingestEvent('agent', {
        subtype: 'transcript_tool_gap',
        session_id: s.sessionId,
        agent: s.agentKind,
        tool_calls_seen: s.toolCallsSeen,
        tool_calls_emitted: s.toolCallsEmitted,
        description: `Parser saw ${s.toolCallsSeen} tool_use turns in source but emitted 0 tool_call events. The transcript format may have changed — tool activity is not being recorded.`
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    } catch (e) { noteDbError('tailer-host', e) }
  }

  s.lastSnapshotBytes = sidecarSize
  s.bytesAppendedSinceSnapshot = 0
}

function fileSha256(p: string): string {
  try {
    const buf = fs.readFileSync(p)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch { return '' }
}

// ─── Session registration ───────────────────────────────────────────────────

/** Register a session for a given adapter + source. Idempotent —
 *  duplicate calls with the same source path are a no-op. */
/** Project-wide `transcript_uuid → event id` index, built lazily on the first
 *  session registration after a project opens and drained as sessions claim
 *  their slices. `null` means "not built yet"; an empty map means "built, and
 *  this project has no agent history". */
let seedIndex: Map<string, Map<string, string>> | null = null

/** Drop the index so the next registration rebuilds it. Called when the
 *  project changes — the old project's ids must never leak into the new one. */
export function resetTailerSeedIndex(): void { seedIndex = null }

function buildSeedIndex(): Map<string, Map<string, string>> {
  const idx = new Map<string, Map<string, string>>()
  // P2-2: use denormalized transcript_uuid column + partial index instead
  // of json_extract full-table scan. Falls back to json_extract for DBs
  // that haven't migrated yet.
  const rows = getDB().prepare(
    `SELECT id, json_extract(data, '$.session_id') AS sid,
            json_extract(data, '$.agent') AS agent,
            transcript_uuid AS uuid
       FROM events
      WHERE agent_type = 'agent'
        AND transcript_uuid IS NOT NULL`
  ).all() as Array<{ id: string; sid: string | null; agent: string | null; uuid: string }>
  for (const r of rows) {
    if (!r.sid || !r.agent) continue
    const key = `${r.agent}:${r.sid}`
    let m = idx.get(key)
    if (!m) { m = new Map(); idx.set(key, m) }
    m.set(r.uuid, r.id)
  }
  return idx
}

function takeSeedSlice(sessionId: string, agentKind: string): Map<string, string> {
  if (!seedIndex) seedIndex = buildSeedIndex()
  const key = `${agentKind}:${sessionId}`
  const slice = seedIndex.get(key)
  if (!slice) return new Map()
  // Transfer ownership: the caller copies these into its own session map, so
  // holding them here as well would double the footprint of the largest
  // structure in the tailer.
  seedIndex.delete(key)
  return slice
}

export function registerSession(agentKind: string, sourcePath: string): void {
  const adapter = registeredAdapters.get(agentKind)
  if (!adapter || !cfg.enabled) return
  if (!agentEnabled(agentKind)) return
  const allowedPaths = cfg.watchPathsByAgent ? cfg.watchPathsByAgent[agentKind] : cfg.watchPaths
  if (cfg.watchPathsByAgent && !allowedPaths?.length) return
  const sessionId = adapter.perMessageDir
    ? path.basename(sourcePath)                                // dir name = session id
    : path.basename(sourcePath, path.extname(sourcePath))      // strip .jsonl
  const key = sessionKey(agentKind, sessionId)
  if (sessions.has(key)) return
  if (!sessionAllowed(agentKind, sessionId)) return
  const cwd = adapter.resolveCwd(sourcePath)
  if (!cwd) return
  if (isSelfExcludedCwd(cwd, cfg.selfExclusionMarker ?? '.redlog-app-root')) return
  if (!cwdPassesGate(cwd, cfg.excludedPaths, allowedPaths)) return
  if (!sessionAllowed(agentKind, sessionId)) return

  let projectDir: string
  try { projectDir = getProjectDir() } catch { return }
  const sidecarDir = path.join(projectDir, 'agent-transcripts')
  try { fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  const sidecarPath = path.join(sidecarDir, `${agentKind}-${sessionId}${activationFor(agentKind, sessionId) ? `-${activationFor(agentKind, sessionId)}` : ''}.jsonl`)
  if (!isInsideDir(sidecarDir, sidecarPath)) return

  let sourceBaseOffset = 0
  const startedAt = activationFor(agentKind, sessionId)
  // File timestamps have fractional milliseconds; ambiguous same-ms bytes
  // belong to the omitted side of a privacy boundary.
  const captureFrom = Math.max(startedAt ?? 0, resumeBoundary)
  if (captureFrom && !adapter.perMessageDir) {
    const cursorPath = sidecarPath + '.offset.json'
    try {
      if (fs.existsSync(cursorPath)) {
        const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
        if (cursor.source !== sourcePath || cursor.startedAt !== startedAt || !Number.isSafeInteger(cursor.base) || cursor.base < 0) throw new Error('Invalid AI capture start cursor')
        sourceBaseOffset = cursor.base
      } else {
        const source = fs.statSync(sourcePath)
        sourceBaseOffset = source.birthtimeMs < captureFrom + 1 ? source.size : 0
        fs.writeFileSync(cursorPath, JSON.stringify({ source: sourcePath, startedAt, base: sourceBaseOffset }), { flag: 'wx', mode: 0o600 })
        ingestEvent('agent', { subtype: 'transcript_capture_started', agent: agentKind, session_id: sessionId, skipped_source_bytes: sourceBaseOffset, activation_requested_at: startedAt, sidecar_file: path.basename(sidecarPath) }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      }
    } catch (e) { noteDbError('tailer-host', e); return }
  }
  const s: SessionState = {
    sessionId,
    agentKind,
    adapter,
    sourcePath,
    sourceBaseOffset,
    sourceOffset: sourceBaseOffset,
    discardPartial: false,
    checkpointPaused: eventBus.paused,
    pauseSkippedBytes: 0,
    resumedAt: 0,
    unitSidecarOffset: 0,
    completedFiles: new Map(),
    skipMissingParents: false,
    ignoredParents: new Map(),
    sidecarPath,
    transcriptCwd: cwd,
    pendingLineBuffer: '',
    redlogIdByUuid: new Map(),
    toolCommandByUseId: new Map(),
    pendingByParentUuid: new Map(),
    linesSeen: 0,
    turnsEmitted: 0,
    postCompact: false,
    idleTimer: null,
    retryTimer: null,
    retryAttempt: 0,
    lastSnapshotBytes: 0,
    bytesAppendedSinceSnapshot: 0,
    driftAdvisoryFired: new Set(),
    parentMissingAdvisoryFired: false,
    toolCallsSeen: 0,
    toolCallsEmitted: 0,
    toolGapAdvisoryFired: false,
    runningHash: crypto.createHash('sha256'),
    pauseSkippedLines: 0,
    pauseStartedAt: null
  }
  try {
    const cursorPath = sidecarPath + '.offset.json'
    if (fs.existsSync(cursorPath)) {
      const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'))
      if (cursor.source !== sourcePath || !Number.isSafeInteger(cursor.base) || !Number.isSafeInteger(cursor.offset ?? cursor.base)
        || (cursor.offset ?? cursor.base) < 0) throw new Error('Invalid AI source checkpoint')
      s.sourceOffset = cursor.offset ?? cursor.base
      s.discardPartial = cursor.discardPartial === true
      s.checkpointPaused = cursor.paused === true || eventBus.paused
      s.pauseSkippedBytes = cursor.skippedBytes ?? 0; s.pauseStartedAt = cursor.gapStartedAt ?? null
      if (cursor.ignoredParents) {
        if (typeof cursor.ignoredParents !== 'object' || Array.isArray(cursor.ignoredParents) || Object.values(cursor.ignoredParents).some(id => id !== null && typeof id !== 'string')) throw new Error('Invalid AI parent metadata')
        s.ignoredParents = new Map(Object.entries(cursor.ignoredParents))
      }
      s.resumedAt = cursor.resumedAt ?? 0; s.skipMissingParents = cursor.skipMissingParents === true; s.replayFrom = cursor.replayFrom
      if (cursor.savedBytes !== undefined) {
        // Retention removes whole sidecars and records it; reading resumes at
        // the checkpoint. A sidecar that is present but short is refused.
        const actual = fs.existsSync(sidecarPath) ? fs.statSync(sidecarPath).size : null
        if (!Number.isSafeInteger(cursor.savedBytes) || cursor.savedBytes < 0 || (actual !== null && actual < cursor.savedBytes)) throw new Error('AI sidecar is shorter than its checkpoint')
        if (actual === null) { cursor.savedBytes = 0; s.replayFrom = undefined }
        if (actual !== null && actual > cursor.savedBytes) fs.truncateSync(sidecarPath, cursor.savedBytes)
      }
    } else checkpoint(s)
  } catch (e) { noteDbError('tailer-host', e); return }
  // Seed running hash from existing sidecar so incremental updates produce
  // the same digest as a full-file read would.
  try {
    const existing = fs.readFileSync(sidecarPath)
    if (existing.length > 0) s.runningHash.update(existing)
  } catch { /* new sidecar — hash starts empty */ }
  sessions.set(key, s)

  // v0.7.4 F2: seed the parent-map from DB so re-ingest post-sidecar-prune
  // doesn't duplicate historical events. Also seeds the per-message-file
  // dedup set (uuid = filename in that case).
  //
  // v0.11.5: one scan for the whole project, not one per session.
  //
  // This used to run its own query per registered session, filtered by
  // `json_extract(data,'$.session_id')` — which no index can serve, so each
  // one scanned the entire `agent` bucket. On a transcript-heavy project that
  // is 131,774 rows and 167 ms, and every session RedLog has ever seen
  // re-registers when the project opens. Measured on a real engagement:
  // 1,075 sessions × 167 ms = **180 seconds** of blocked main process, which
  // is exactly the "opening this project makes everything stutter" report.
  //
  // Building the whole map in a single pass takes 309 ms for the same data.
  // Slices are handed out and deleted as sessions claim them, so the index
  // does not sit alongside the per-session maps it feeds.
  try {
    const slice = takeSeedSlice(sessionId, agentKind)
    for (const [uuid, id] of slice) s.redlogIdByUuid.set(uuid, id)
  } catch (e) { noteDbError('tailer-host', e) }

  // For per-message adapters we ALSO read the sidecar-as-index to seed
  // the filename dedup set (in case DB seed missed anything, e.g. a
  // crash between sidecar append and DB insert). Only fill entries the DB
  // seed didn't already populate — otherwise the sentinel would clobber
  // the real event id and later `_causes` lookups would produce the
  // string `'__seen__'` instead of a proper parent RedLog id.
  if (adapter.perMessageDir) {
    try {
      const idx = fs.readFileSync(sidecarPath, 'utf-8')
      for (const raw of idx.split('\n')) {
        const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (name.startsWith('!pause:')) { s.redlogIdByUuid.set(name.slice(7), '__paused__'); continue }
        if (name && !s.redlogIdByUuid.has(name)) {
          s.redlogIdByUuid.set(name, '__seen__')  // sentinel, not a real id
        }
      }
    } catch { /* new sidecar, no index yet */ }
  }

  if (!eventBus.paused && !s.checkpointPaused && s.replayFrom !== undefined && !adapter.perMessageDir) {
    try {
      const bytes = fs.readFileSync(sidecarPath)
      if (!Number.isSafeInteger(s.replayFrom) || s.replayFrom < 0 || s.replayFrom > bytes.length) throw new Error('Invalid AI pending replay boundary')
      s.unitSidecarOffset = s.replayFrom
      for (const line of bytes.subarray(s.replayFrom).toString('utf8').split('\n')) {
        if (line.trim()) processUnit(s, line, sourcePath)
        s.unitSidecarOffset += Buffer.byteLength(line + '\n')
      }
    } catch (e) { noteDbError('tailer-host', e); sessions.delete(key); return }
  }
  catchUpSession(agentKind, sessionId)
}

function unregisterSession(key: string): void {
  const s = sessions.get(key)
  if (!s) return
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null }
  const ct = coalesceTimers.get(key)
  if (ct) { clearTimeout(ct); coalesceTimers.delete(key) }
  // v0.7.4 F4: skip snapshot + session_end emits when paused. Still remove
  // the session from the map so a subsequent resume + re-register picks up.
  if (!eventBus.paused) {
    emitSnapshot(s, 'session_close')
    try {
      const ev = ingestEvent('agent', {
        subtype: 'session_end',
        agent: s.agentKind,
        session_id: s.sessionId,
        turns_emitted: s.turnsEmitted,
        lines_seen: s.linesSeen,
        description: 'Transcript source removed or tailer shutting down; no more events for this session.'
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    } catch (e) { noteDbError('tailer-host', e) }
  }
  sessions.delete(key)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function configureHost(next: Partial<TailerHostConfig>): void {
  stopHost()
  cfg = { ...cfg, ...next }
  if (cfg.enabled) {
    try { restoreBoundary() } catch (e) { for (const kind of cfg.enabledAgents ?? registeredAdapters.keys()) noteCaptureError(`agent-${kind}`, e); cfg.enabled = false; return }
  }
  restartAll()
}

export function stopHost(): void {
  ++hostGeneration
  for (const kind of initializedAdapters) registeredAdapters.get(kind)?.stop?.()
  initializedAdapters.clear()
  for (const [, w] of watchersByAgent) void w.close()
  watchersByAgent.clear()
  for (const [, t] of coalesceTimers) clearTimeout(t)
  coalesceTimers.clear()
  for (const [key] of sessions) unregisterSession(key)
  sessions.clear()
  sessionRegistry.clear()
  // The seed index is keyed by session, not by project, and holds event ids
  // from whichever database was open when it was built. Closing the host is
  // the boundary — dropping it here means a project switch can never hand the
  // new project's tailer a parent id belonging to the old one.
  resetTailerSeedIndex()
}

function restartAll(): void {
  if (!cfg.enabled || !cfg.engagementId || !cfg.operatorId) {
    return
  }
  for (const adapter of registeredAdapters.values()) restartAdapter(adapter)
}

function restartAdapter(adapter: TailerAdapter): void {
  const w = watchersByAgent.get(adapter.agentKind)
  if (w) void w.close()
  if (!cfg.enabled || !agentEnabled(adapter.agentKind) || (cfg.watchPathsByAgent && !cfg.watchPathsByAgent[adapter.agentKind]?.length)) { watchersByAgent.delete(adapter.agentKind); return }
  const generation = hostGeneration
  const current = (): boolean => generation === hostGeneration && cfg.enabled && agentEnabled(adapter.agentKind)
  const root = adapter.transcriptRoot ?? expandTilde(adapter.transcriptGlob.split('*')[0] || adapter.transcriptGlob)
  const watchDir = adapter.perMessageDir
    ? root  // per-message: watch parent dir, each subdir/file is a session
    : root  // per-line: same — chokidar filters within
  if (adapter.init && !initializedAdapters.has(adapter.agentKind)) {
    initializedAdapters.add(adapter.agentKind)
    adapter.init({ acceptsMessage: (kind, msg, changedAt) => current() && hostControlSurface.acceptsMessage(kind, msg, changedAt), emitTurns: (kind, sid, turns) => { if (current()) hostControlSurface.emitTurns(kind, sid, turns) } })
  }
  const isJsonl = !adapter.perMessageDir
  let existing = path.resolve(watchDir)
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
  const missing = path.relative(existing, path.resolve(watchDir))
  const watchTarget = fs.realpathSync(existing)
  const watchDirCanon = path.join(watchTarget, missing)
  const watcher = chokidar.watch(missing ? watchTarget : watchDirCanon, {
    disableGlobbing: true,
    // Ignore nested hidden paths, not the explicitly authorized transcript
    // root (.codex/.claude). Directories must remain traversable: filtering
    // every non-jsonl path here also filtered all intermediate directories.
    ignored: (p: string, stat?: fs.Stats): boolean => {
      const candidate = path.resolve(p)
      const relative = path.relative(watchDirCanon, candidate)
      // Chokidar checks missing roots through their existing ancestors. Keep
      // those directories traversable without admitting sibling files/trees.
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        return !(watchDirCanon.startsWith(candidate + path.sep) && (!stat || stat.isDirectory()))
      }
      if (relative.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules')) return true
      return !!(isJsonl && stat?.isFile() && !p.endsWith('.jsonl'))
    },
    persistent: true,
    ignoreInitial: false,
    depth: 6 + (missing ? missing.split(path.sep).length : 0),
    awaitWriteFinish: false
  })
  watcher.on('add', (p) => {
    if (!current()) return
    if (isJsonl) {
      if (p.endsWith('.jsonl')) {
        registerSession(adapter.agentKind, p)
      }
      return
    }
    // v0.8.0.1: per-message layout. A msg file landed inside a session dir.
    // Find the session dir (direct child of watchDir), then register-or-catchup.
    const sessionDir = perMessageSessionDirFor(p, watchDirCanon)
    if (!sessionDir) return
    const sid = path.basename(sessionDir)
    const key = sessionKey(adapter.agentKind, sid)
    if (sessions.has(key)) catchUpSession(adapter.agentKind, sid)
    else registerSession(adapter.agentKind, sessionDir)
  })
  watcher.on('addDir', (p) => {
    if (!current()) return
    // v0.8.0.1: per-message layout. Only register directories that are
    // DIRECT children of the watched root — those correspond to session
    // ids (e.g. `~/.../storage/message/ses_abc`). Anything nested or the
    // root itself is not a session and would corrupt state.
    if (isJsonl) return
    if (path.dirname(path.resolve(p)) !== watchDirCanon) return
    registerSession(adapter.agentKind, p)
  })
  watcher.on('change', (p) => {
    if (!current()) return
    if (isJsonl) {
      if (!p.endsWith('.jsonl')) return
      const sid = path.basename(p, '.jsonl')
      const key = sessionKey(adapter.agentKind, sid)
      if (sessions.has(key)) coalescedCatchUp(adapter.agentKind, sid)
      else registerSession(adapter.agentKind, p)
      return
    }
    // Per-message: rewriting an existing msg file — re-run catch-up
    // (the dedup set skips already-processed filenames).
    const sessionDir = perMessageSessionDirFor(p, watchDirCanon)
    if (!sessionDir) return
    const sid = path.basename(sessionDir)
    const key = sessionKey(adapter.agentKind, sid)
    if (sessions.has(key)) coalescedCatchUp(adapter.agentKind, sid)
  })
  watcher.on('unlink', (p) => {
    if (!current()) return
    if (isJsonl) {
      if (!p.endsWith('.jsonl')) return
      const sid = path.basename(p, '.jsonl')
      unregisterSession(sessionKey(adapter.agentKind, sid))
    }
    // Per-message: individual msg-file deletion doesn't close a session.
  })
  watcher.on('unlinkDir', (p) => {
    if (!current()) return
    if (isJsonl) return
    if (path.dirname(path.resolve(p)) !== watchDirCanon) return
    const sid = path.basename(p)
    unregisterSession(sessionKey(adapter.agentKind, sid))
  })
  watchersByAgent.set(adapter.agentKind, watcher)
}

/** Given a file `p` that lives somewhere under `watchDirCanon`, return the
 *  direct-child directory of `watchDirCanon` that contains it — i.e. the
 *  session dir for a per-message adapter. Returns null if `p` is not
 *  inside a session dir. */
function perMessageSessionDirFor(p: string, watchDirCanon: string): string | null {
  const resolved = path.resolve(p)
  if (!resolved.startsWith(watchDirCanon + path.sep)) return null
  const rel = resolved.slice(watchDirCanon.length + 1)
  const firstSep = rel.indexOf(path.sep)
  if (firstSep === -1) return null  // file directly under watchDir (not a session)
  return path.join(watchDirCanon, rel.slice(0, firstSep))
}

// ─── Test-only introspection ────────────────────────────────────────────────

export function _sessionsForTest(): Map<string, SessionState> {
  return sessions
}

/** Test-only. Exposes the same HostControlSurface that adapter.init(...)
 *  receives, so tests can exercise the emit-turns path directly without
 *  registering a wrapper adapter. */
export function _hostControlSurfaceForTest(): HostControlSurface {
  return hostControlSurface
}
