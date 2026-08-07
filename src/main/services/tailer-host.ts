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
// - Sidecar file management under `<projectDir>/agent-transcripts/`
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
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { getProjectDir, getDB } from '../../core/db/index'
import { noteDbError } from '../../core/capture-health'
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
   *  registered (i.e. when `registerAdapter(adapter)` is called or a
   *  restart replays through it). Receives a control surface the adapter
   *  can use to emit supplemental turns from sources the host does not
   *  natively watch. Idempotent — the host guards against duplicate init
   *  calls on repeated registerAdapter. Adapter is responsible for tearing
   *  down its own watchers on process exit. */
  init?(host: HostControlSurface): void
}

/** Host-level configuration shared across all registered adapters. */
export interface TailerHostConfig {
  enabled: boolean
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
  /** Same as claude-code-hook.sh's `~/.redlog/hook-config.json`
   *  `excludedPaths` — if a session's cwd matches any of these prefixes,
   *  tailing is skipped. */
  excludedPaths?: string[]
  /** Legacy v0.6.59 whitelist. When non-empty, ONLY these cwds are
   *  tailed. */
  watchPaths?: string[]
}

// ─── Session state ──────────────────────────────────────────────────────────

interface SessionState {
  sessionId: string
  agentKind: string
  adapter: TailerAdapter
  sourcePath: string
  sidecarPath: string
  transcriptCwd: string
  pendingLineBuffer: string
  redlogIdByUuid: Map<string, string>
  toolCommandByUseId: Map<string, string>
  pendingByParentUuid: Map<string, Array<{ turn: ParsedTurn; queuedAt: number }>>
  linesSeen: number
  turnsEmitted: number
  postCompact: boolean
  idleTimer: NodeJS.Timeout | null
  lastSnapshotBytes: number
  bytesAppendedSinceSnapshot: number
  driftAdvisoryFired: boolean
  parentMissingAdvisoryFired: boolean
}

const registeredAdapters = new Map<string, TailerAdapter>()
let cfg: TailerHostConfig = { enabled: false, engagementId: '', operatorId: '' }
const watchersByAgent = new Map<string, FSWatcher>()
/** Keyed by `${agentKind}:${sessionId}` — two adapters can produce the same
 *  bare sessionId (e.g. Codex + Claude both name a session 'rollout-abc'). */
const sessions = new Map<string, SessionState>()

function sessionKey(agentKind: string, sessionId: string): string {
  return `${agentKind}:${sessionId}`
}

// ─── Adapter registry ───────────────────────────────────────────────────────

const initializedAdapters = new Set<string>()

const hostControlSurface: HostControlSurface = {
  emitTurns(agentKind: string, sessionId: string, turns: ParsedTurn[]): void {
    if (eventBus.paused) return
    const s = sessions.get(sessionKey(agentKind, sessionId))
    if (!s) {
      // No live session — the msg stub for this sessionId hasn't been
      // observed yet. Drop silently; the adapter is expected to retry (or
      // the primary watcher will pick up the session soon).
      return
    }
    for (const turn of turns) {
      if (!s.adapter.knownIngestTypes.has(turn.type)) continue
      emitTurn(turn, { session: s })
    }
  }
}

export function registerAdapter(adapter: TailerAdapter): void {
  registeredAdapters.set(adapter.agentKind, adapter)
  // v0.8.3: one-shot init hook. Guarded so a repeated registerAdapter
  // (e.g. same adapter re-registered after unregisterAdapter for whatever
  // reason) doesn't wire duplicate watchers.
  if (adapter.init && !initializedAdapters.has(adapter.agentKind)) {
    initializedAdapters.add(adapter.agentKind)
    try { adapter.init(hostControlSurface) } catch (e) { noteDbError('tailer-host', e) }
  }
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
  const normalize = (p: string): string => path.resolve(expandTilde(p)).replace(/\/$/, '')
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

function defaultPickCommandForCache(_toolName: string | undefined, input: Record<string, unknown>): string | null {
  const priority = ['command', 'file_path', 'path', 'url', 'query']
  for (const k of priority) {
    const v = input[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

// ─── Emit ───────────────────────────────────────────────────────────────────

interface EmitContext {
  session: SessionState
}

function emitTurn(t: ParsedTurn, ctx: EmitContext): void {
  if (!t.uuid) return
  const s = ctx.session
  if (s.redlogIdByUuid.has(t.uuid)) return

  // v0.7.5 G2: pending-parent buffer. Adapter guarantees ordering only
  // within a JSONL file; Claude Code has been observed writing children
  // before parents in ~0.09% of turns. Buffer them; flush recursively
  // when the parent lands.
  let causesArr: string[] | undefined
  if (t.parentUuid) {
    const parentRid = s.redlogIdByUuid.get(t.parentUuid)
    if (parentRid) {
      causesArr = [parentRid]
    } else {
      sweepStalePending(s)
      const queue = s.pendingByParentUuid.get(t.parentUuid) ?? []
      if (queue.length + pendingSize(s) < MAX_PENDING_CHILDREN) {
        queue.push({ turn: t, queuedAt: Date.now() })
        s.pendingByParentUuid.set(t.parentUuid, queue)
        return
      }
      if (!s.parentMissingAdvisoryFired) {
        s.parentMissingAdvisoryFired = true
        try {
          const ev = insertEvent('agent', {
            subtype: 'transcript_parent_missing',
            session_id: s.sessionId,
            agent: s.agentKind,
            parent_uuid: t.parentUuid,
            child_uuid: t.uuid,
            child_type: t.type,
            pending_full: true,
            description: `Pending-parent buffer full (>${MAX_PENDING_CHILDREN}). Later children with missing parents emit without _causes rather than deferring indefinitely.`
          }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
          if (ev) eventBus.publish(ev)
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
    ...(t.model ? { model: t.model } : {}),
    ...(t.version ? { agent_version: t.version } : {}),
    ...(t.gitBranch ? { git_branch: t.gitBranch } : {}),
    ...(t.promptId ? { prompt_id: t.promptId } : {}),
    ...(t.permissionMode ? { permission_mode: t.permissionMode } : {}),
    ...(t.isSidechain ? { is_sidechain: true } : {}),
    ...(s.postCompact ? { post_compact: true } : {}),
    ...(typeof t.usageTokensIn === 'number' ? { usage_tokens_in: t.usageTokensIn } : {}),
    ...(typeof t.usageTokensOut === 'number' ? { usage_tokens_out: t.usageTokensOut } : {}),
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
      const redInput = deepRedactStrings(t.toolInput) as Record<string, unknown>
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
  }

  try {
    const ev = insertEvent('agent', data, {
      engagementId: cfg.engagementId,
      operatorId: cfg.operatorId
    })
    if (ev) {
      s.redlogIdByUuid.set(t.uuid, ev.id)
      s.turnsEmitted++
      eventBus.publish(ev)
      const waiting = s.pendingByParentUuid.get(t.uuid)
      if (waiting) {
        s.pendingByParentUuid.delete(t.uuid)
        for (const q of waiting) emitTurn(q.turn, ctx)
      }
    }
  } catch (e) { noteDbError('tailer-host', e) }
}

function sweepStalePending(s: SessionState): void {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [parentUuid, queue] of s.pendingByParentUuid) {
    const alive = queue.filter((q) => q.queuedAt >= cutoff)
    if (alive.length === 0) s.pendingByParentUuid.delete(parentUuid)
    else if (alive.length !== queue.length) s.pendingByParentUuid.set(parentUuid, alive)
  }
}

function pendingSize(s: SessionState): number {
  let n = 0
  for (const queue of s.pendingByParentUuid.values()) n += queue.length
  return n
}

// ─── Ingest loop ────────────────────────────────────────────────────────────

/** Catch a session up from `sidecarSize` to the current source size.
 *  Handles both per-line (JSONL) and per-message (file-per-unit) adapters
 *  based on `adapter.perMessageDir`. Public for testability. */
export function catchUpSession(agentKind: string, sessionId: string): void {
  if (eventBus.paused) return
  const s = sessions.get(sessionKey(agentKind, sessionId))
  if (!s) return
  if (s.adapter.perMessageDir) {
    catchUpPerMessageDir(s)
  } else {
    catchUpJsonl(s)
  }
}

function catchUpJsonl(s: SessionState): void {
  let sourceSize: number
  try { sourceSize = fs.statSync(s.sourcePath).size } catch { return }
  let sidecarSize = 0
  try { sidecarSize = fs.statSync(s.sidecarPath).size } catch { /* new */ }

  const shouldReset = s.adapter.detectReset
    ? s.adapter.detectReset(sidecarSize, sourceSize)
    : (sourceSize < sidecarSize)

  if (shouldReset) {
    const oldHash = fileSha256(s.sidecarPath)
    try { fs.truncateSync(s.sidecarPath, 0) } catch { /* ignore */ }
    s.pendingLineBuffer = ''
    s.redlogIdByUuid.clear()
    s.linesSeen = 0
    s.postCompact = true
    s.lastSnapshotBytes = 0
    s.bytesAppendedSinceSnapshot = 0
    try {
      const ev = insertEvent('agent', {
        subtype: 'transcript_compacted',
        session_id: s.sessionId,
        agent: s.agentKind,
        old_sidecar_bytes: sidecarSize,
        old_sidecar_sha256: oldHash,
        new_source_bytes: sourceSize,
        description: 'Source transcript shrunk (likely /compact, /clear, or adapter-specific reset). Sidecar reset; subsequent per-turn events are tagged post_compact=true.'
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      if (ev) eventBus.publish(ev)
    } catch (e) { noteDbError('tailer-host', e) }
    sidecarSize = 0
  }

  if (sourceSize <= sidecarSize) return

  const toRead = sourceSize - sidecarSize
  let bytes: Buffer
  try {
    const handle = fs.openSync(s.sourcePath, 'r')
    try {
      bytes = Buffer.alloc(toRead)
      let readTotal = 0
      while (readTotal < toRead) {
        const n = fs.readSync(handle, bytes, readTotal, toRead - readTotal, sidecarSize + readTotal)
        if (n === 0) break
        readTotal += n
      }
      bytes = bytes.slice(0, readTotal)
    } finally { try { fs.closeSync(handle) } catch { /* ignore */ } }
  } catch (e) { noteDbError('tailer-host', e); return }

  try { fs.appendFileSync(s.sidecarPath, bytes) } catch (e) {
    noteDbError('tailer-host', e); return
  }
  s.bytesAppendedSinceSnapshot += bytes.length

  const text = s.pendingLineBuffer + bytes.toString('utf-8')
  const lastNl = text.lastIndexOf('\n')
  const complete = lastNl === -1 ? '' : text.slice(0, lastNl)
  s.pendingLineBuffer = lastNl === -1 ? text : text.slice(lastNl + 1)

  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    s.linesSeen++
    processUnit(s, line, s.sourcePath)
  }

  scheduleIdleSnapshot(s)
}

/** Per-message directory scan: each new file in the watched dir is one
 *  unit. Sidecar stores an index of processed filenames (line-per-name)
 *  so restart-safe by construction. */
function catchUpPerMessageDir(s: SessionState): void {
  // The "source path" for a per-message adapter is a DIRECTORY. List its
  // contents, filter to files we haven't seen, sort by mtime, and process.
  let entries: string[] = []
  try { entries = fs.readdirSync(s.sourcePath) } catch { return }
  // Sidecar for a per-message adapter is an append-only newline-delimited
  // index of processed filenames. Reload it into memory at register-time
  // (see registerSession); check membership by looking at
  // `s.redlogIdByUuid.has(filename)` where the "uuid" IS the filename.
  const toProcess: Array<{ name: string; full: string; mtime: number }> = []
  for (const name of entries) {
    if (s.redlogIdByUuid.has(name)) continue
    const full = path.join(s.sourcePath, name)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    toProcess.push({ name, full, mtime: stat.mtimeMs })
  }
  toProcess.sort((a, b) => a.mtime - b.mtime)

  for (const p of toProcess) {
    let raw: string
    try { raw = fs.readFileSync(p.full, 'utf-8') } catch { continue }
    s.linesSeen++
    // Append the filename to the sidecar index so a crash before emit
    // still records "we saw this file" — next tick's dedup check skips it.
    try { fs.appendFileSync(s.sidecarPath, p.name + '\n') } catch { /* ignore */ }
    s.bytesAppendedSinceSnapshot += p.name.length + 1
    // For per-message adapters we treat the FILENAME as the uuid so dedup
    // works — parseUnit's returned `.uuid` is expected to be the filename
    // OR a real uuid; either way emitTurn's dedup covers it. sourcePath
    // passed here is the individual unit file (so adapters like OpenCode
    // can resolve sibling `part/msg_<id>/` dirs).
    processUnit(s, raw, p.full)
  }
  scheduleIdleSnapshot(s)
}

function processUnit(s: SessionState, rawContent: string, sourcePath: string): void {
  let raw: ParsedTurn | ParsedTurn[] | null
  try {
    raw = s.adapter.parseUnit(rawContent, sourcePath)
  } catch (e) {
    // Adapter blew up on a single unit — count it as schema drift, don't
    // crash the whole session's ingest.
    if (!s.driftAdvisoryFired) {
      s.driftAdvisoryFired = true
      try {
        const ev = insertEvent('agent', {
          subtype: 'transcript_schema_drift',
          session_id: s.sessionId,
          agent: s.agentKind,
          unknown_type: '<parse_error>',
          description: 'Adapter.parseUnit() threw. See stderr for details.'
        }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
        if (ev) eventBus.publish(ev)
      } catch (err) { noteDbError('tailer-host', err) }
    }
    noteDbError('tailer-host', e)
    return
  }
  if (!raw) return
  const turns = Array.isArray(raw) ? raw : [raw]

  for (const turn of turns) {
    // Schema-drift check: parseUnit returned a turn whose type isn't in the
    // adapter's whitelist. Fire the advisory once per session and skip.
    if (!s.adapter.knownIngestTypes.has(turn.type)) {
      if (!s.driftAdvisoryFired) {
        s.driftAdvisoryFired = true
        try {
          const ev = insertEvent('agent', {
            subtype: 'transcript_schema_drift',
            session_id: s.sessionId,
            agent: s.agentKind,
            unknown_type: turn.type,
            description: `Encountered a transcript line type not in the adapter whitelist. Skipping only this type.`
          }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
          if (ev) eventBus.publish(ev)
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
  const sha = fileSha256(s.sidecarPath)
  try {
    const ev = insertEvent('agent', {
      subtype: 'transcript_snapshot',
      session_id: s.sessionId,
      agent: s.agentKind,
      snapshot_path: s.sidecarPath,
      cumulative_bytes: sidecarSize,
      cumulative_sha256: sha,
      line_count: s.linesSeen,
      turns_emitted: s.turnsEmitted,
      reason
    }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('tailer-host', e) }
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
export function registerSession(agentKind: string, sourcePath: string): void {
  const adapter = registeredAdapters.get(agentKind)
  if (!adapter) return
  const sessionId = adapter.perMessageDir
    ? path.basename(sourcePath)                                // dir name = session id
    : path.basename(sourcePath, path.extname(sourcePath))      // strip .jsonl
  const key = sessionKey(agentKind, sessionId)
  if (sessions.has(key)) return
  const cwd = adapter.resolveCwd(sourcePath)
  if (!cwd) return
  if (isSelfExcludedCwd(cwd, cfg.selfExclusionMarker ?? '.redlog-app-root')) return
  if (!cwdPassesGate(cwd, cfg.excludedPaths, cfg.watchPaths)) return

  let projectDir: string
  try { projectDir = getProjectDir() } catch { return }
  const sidecarDir = path.join(projectDir, 'agent-transcripts')
  try { fs.mkdirSync(sidecarDir, { recursive: true }) } catch { /* ignore */ }
  const sidecarPath = path.join(sidecarDir, `${agentKind}-${sessionId}.jsonl`)
  if (!isInsideDir(sidecarDir, sidecarPath)) return

  const s: SessionState = {
    sessionId,
    agentKind,
    adapter,
    sourcePath,
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
    lastSnapshotBytes: 0,
    bytesAppendedSinceSnapshot: 0,
    driftAdvisoryFired: false,
    parentMissingAdvisoryFired: false
  }
  sessions.set(key, s)

  // v0.7.4 F2: seed the parent-map from DB so re-ingest post-sidecar-prune
  // doesn't duplicate historical events. Also seeds the per-message-file
  // dedup set (uuid = filename in that case).
  try {
    const db = getDB()
    const rows = db.prepare(
      `SELECT id, json_extract(data, '$.transcript_uuid') AS uuid
         FROM events
        WHERE agent_type = 'agent'
          AND json_extract(data, '$.session_id') = ?
          AND json_extract(data, '$.agent') = ?
          AND json_extract(data, '$.transcript_uuid') IS NOT NULL`
    ).all(sessionId, agentKind) as Array<{ id: string; uuid: string }>
    for (const row of rows) s.redlogIdByUuid.set(row.uuid, row.id)
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
      for (const name of idx.split('\n')) {
        if (name && !s.redlogIdByUuid.has(name)) {
          s.redlogIdByUuid.set(name, '__seen__')  // sentinel, not a real id
        }
      }
    } catch { /* new sidecar, no index yet */ }
  }

  catchUpSession(agentKind, sessionId)
}

function unregisterSession(key: string): void {
  const s = sessions.get(key)
  if (!s) return
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
  // v0.7.4 F4: skip snapshot + session_end emits when paused. Still remove
  // the session from the map so a subsequent resume + re-register picks up.
  if (!eventBus.paused) {
    emitSnapshot(s, 'session_close')
    try {
      const ev = insertEvent('agent', {
        subtype: 'session_end',
        agent: s.agentKind,
        session_id: s.sessionId,
        turns_emitted: s.turnsEmitted,
        lines_seen: s.linesSeen,
        description: 'Transcript source removed or tailer shutting down; no more events for this session.'
      }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
      if (ev) eventBus.publish(ev)
    } catch (e) { noteDbError('tailer-host', e) }
  }
  sessions.delete(key)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/** Mutate the host config WITHOUT tearing down active watchers/sessions.
 *  Used by test-mode `registerSession(source, cfg)` shims that want to
 *  inject configuration for a single upcoming register call — a full
 *  `configureHost` there would fire a spurious `session_end` for every
 *  live session (v0.8.0.1 F2). Production callers hitting real config
 *  changes should use `configureHost` so watchers rebind. */
export function setHostConfig(next: Partial<TailerHostConfig>): void {
  cfg = { ...cfg, ...next }
}

export function configureHost(next: Partial<TailerHostConfig>): void {
  cfg = { ...cfg, ...next }
  restartAll()
}

export function startHost(next?: Partial<TailerHostConfig>): void {
  if (next) cfg = { ...cfg, ...next }
  restartAll()
}

export function stopHost(): void {
  for (const [, w] of watchersByAgent) void w.close()
  watchersByAgent.clear()
  for (const [key] of sessions) unregisterSession(key)
  sessions.clear()
}

function restartAll(): void {
  stopHost()
  if (!cfg.enabled || !cfg.engagementId || !cfg.operatorId) return
  for (const adapter of registeredAdapters.values()) restartAdapter(adapter)
}

function restartAdapter(adapter: TailerAdapter): void {
  const w = watchersByAgent.get(adapter.agentKind)
  if (w) void w.close()
  const root = expandTilde(adapter.transcriptGlob.split('*')[0] || adapter.transcriptGlob)
  const watchDir = adapter.perMessageDir
    ? root  // per-message: watch parent dir, each subdir/file is a session
    : root  // per-line: same — chokidar filters within
  if (!fs.existsSync(watchDir)) return
  const isJsonl = !adapter.perMessageDir
  const watchDirCanon = path.resolve(watchDir)
  const watcher = chokidar.watch(watchDir, {
    ignored: (p) => {
      const stat = fs.statSync(p, { throwIfNoEntry: false })
      if (stat?.isDirectory()) return false
      // For JSONL adapters, watch files ending .jsonl. For per-message,
      // the "session" IS a directory containing per-message files —
      // chokidar's directory-add is what triggers registerSession.
      if (isJsonl) return !p.endsWith('.jsonl')
      return false
    },
    persistent: true,
    ignoreInitial: false,
    depth: 6,
    awaitWriteFinish: false
  })
  watcher.on('add', (p) => {
    if (isJsonl) {
      if (p.endsWith('.jsonl')) registerSession(adapter.agentKind, p)
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
    // v0.8.0.1: per-message layout. Only register directories that are
    // DIRECT children of the watched root — those correspond to session
    // ids (e.g. `~/.../storage/message/ses_abc`). Anything nested or the
    // root itself is not a session and would corrupt state.
    if (isJsonl) return
    if (path.dirname(path.resolve(p)) !== watchDirCanon) return
    registerSession(adapter.agentKind, p)
  })
  watcher.on('change', (p) => {
    if (isJsonl) {
      if (!p.endsWith('.jsonl')) return
      const sid = path.basename(p, '.jsonl')
      const key = sessionKey(adapter.agentKind, sid)
      if (sessions.has(key)) catchUpSession(adapter.agentKind, sid)
      else registerSession(adapter.agentKind, p)
      return
    }
    // Per-message: rewriting an existing msg file — re-run catch-up
    // (the dedup set skips already-processed filenames).
    const sessionDir = perMessageSessionDirFor(p, watchDirCanon)
    if (!sessionDir) return
    const sid = path.basename(sessionDir)
    const key = sessionKey(adapter.agentKind, sid)
    if (sessions.has(key)) catchUpSession(adapter.agentKind, sid)
  })
  watcher.on('unlink', (p) => {
    if (isJsonl) {
      if (!p.endsWith('.jsonl')) return
      const sid = path.basename(p, '.jsonl')
      unregisterSession(sessionKey(adapter.agentKind, sid))
    }
    // Per-message: individual msg-file deletion doesn't close a session.
  })
  watcher.on('unlinkDir', (p) => {
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

export function _resetForTest(): void {
  stopHost()
  registeredAdapters.clear()
  initializedAdapters.clear()
  cfg = { enabled: false, engagementId: '', operatorId: '' }
}
