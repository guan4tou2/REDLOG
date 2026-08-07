// v0.7.2 A — Agent-transcript tailer.
//
// Watches Claude Code's per-session JSONL transcripts at
// `~/.claude/projects/**/<session_id>.jsonl` and derives per-turn audit
// events (`agent.user_message`, `agent.assistant_message`, `agent.tool_call`,
// `agent.tool_result`, etc.) into RedLog's hash-chained evidence log. Also
// maintains an append-only sidecar copy under `<projectDir>/agent-transcripts/`
// so the raw JSONL survives Claude Code's own cache eviction and stays
// tamper-detectable via the `agent.transcript_snapshot` events' sha256.
//
// Why not a Claude Code hook? The existing hook (v0.6.66+) only fires
// on `PostToolUse` matcher `Bash` and truncates output at 500 chars. Its
// design-review reviewers pushed us to a hybrid:
//   - keep the hook, but only for session-boundary markers (fast, low-latency)
//   - tailer owns per-tool + prompt/response ingest (complete, redacted)
// Prior art: Tailward (pypi.org/project/tailward) does something similar
// with a SQLite ledger but no hash chain — that's our differentiator.
//
// Design choices (locked in by the two-agent review the operator ran before
// I wrote a line):
// - Sidecar file size is the source of truth for "how many bytes have we
//   read." No DB column tracks offset. On startup after a crash the
//   sidecar's .size tells us exactly where to resume, and the sidecar is
//   idempotent by construction.
// - `_causes: [redlog_event_id]` — we build an in-memory
//   `Map<transcriptUuid, redlogEventId>` per session so per-turn events
//   link via RedLog ids, not foreign Claude Code UUIDs. Claude Code writes
//   parent-first in practice; if that assumption ever breaks we emit an
//   `agent.transcript_parent_missing` advisory instead of buffering (dead
//   code in the common path).
// - Redaction runs on the string that goes INTO the events table only.
//   The sidecar keeps verbatim bytes — that's the raw evidence copy, and
//   v0.7.2 F excludes `agent-transcripts/` from the default bundle export
//   so the raw content requires an explicit `--include-agent-transcripts`
//   opt-in.
// - Self-exclusion: cwd containing a `.redlog-app-root` marker file skips
//   tailing entirely (RedLog watching its own dev session = feedback loop).
// - `/compact` (Claude Code inline summary rewrite) → we detect
//   `type:"user"` + `isCompactSummary:true`; `/clear` (file replacement,
//   inode change) → chokidar's `unlink`+`add` pair triggers re-init.
// - Transcript schema is officially "internal — can break between
//   releases" per code.claude.com/docs/en/sessions. We whitelist known
//   line types and route unknown types into a count-only bucket with
//   an advisory `agent.transcript_schema_drift` event.

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

// ─── Config + state ─────────────────────────────────────────────────────────

export interface AgentTailerConfig {
  enabled: boolean
  engagementId: string
  operatorId: string
  /** Root of Claude Code's per-session transcripts. Overridable for tests
   *  and for cross-platform paths — resolveDefaultClaudeDir() picks the
   *  right home on macOS/Linux/Windows. */
  claudeProjectsDir?: string
  /** Marker filename that signals "this cwd is RedLog's own dev tree —
   *  do not tail its Claude Code sessions." Present as a checked-in file
   *  at the repo root (see `.redlog-app-root`); nothing writes it at
   *  runtime, so cloning the repo is enough to activate the exclusion.
   *  v0.7.4 F7: corrected — earlier revisions said this file was written
   *  by Electron main at first launch, which was never true. */
  selfExclusionMarker?: string
  /** Idle-flush window for `agent.transcript_snapshot` emit. */
  idleFlushMs?: number
  /** How many chars of the redacted string to keep in `preview` — the
   *  full-content field is capped separately at MAX_FULL_BYTES. */
  previewChars?: number
  /** Optional: emit `agent.thinking` events (thinking blocks are large
   *  and mostly meta — off by default). */
  emitThinking?: boolean
  /** Path filter: skip a session if its transcript-recorded cwd matches
   *  any of these prefixes. Sourced from ~/.redlog/hook-config.json to
   *  keep policy identical to the shell hook. */
  excludedPaths?: string[]
  /** Legacy watchPaths (v0.6.59) — if set + non-empty, ONLY these cwds
   *  are tailed. New configs should prefer excludedPaths. */
  watchPaths?: string[]
}

const DEFAULT_CFG: Required<Omit<AgentTailerConfig, 'engagementId' | 'operatorId' | 'excludedPaths' | 'watchPaths'>> = {
  enabled: false,
  claudeProjectsDir: '',
  selfExclusionMarker: '.redlog-app-root',
  idleFlushMs: 15_000,
  previewChars: 500,
  emitThinking: false
}

/** Max bytes we keep in the events-table `full` field per turn. Anything
 *  larger is truncated with `truncated: true`; the sidecar still has the
 *  original. Chosen to match hook's opt-in `redlog-run` cap (v0.6.87 A2). */
const MAX_FULL_BYTES = 100 * 1024

/** Line types we route to per-turn events. Others land in `line_count`
 *  only; if a novel type shows up we fire `agent.transcript_schema_drift`
 *  once per session. Extended by Tailward's edge cases. */
const KNOWN_INGEST_TYPES = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'tool_interrupted',
  'away_summary'
])

/** Types the schema-drift check should treat as "we know about these but
 *  don't emit an event." Prevents false-positive advisories on every
 *  session-start metadata line. */
const KNOWN_IGNORED_TYPES = new Set([
  'summary',
  'custom-title',
  'mode',
  'queue-operation',
  'attachment',
  'system',
  'meta',
  // v0.7.5 G1: `last-prompt` observed in real Claude Code transcripts
  // (v0.7.4 dogfood test surfaced 6 spurious schema-drift advisories on
  // this type). Metadata-only line pointing at the most recent user
  // prompt; skipping it is correct.
  'last-prompt'
])

interface SessionState {
  sessionId: string
  agent: 'claude-code'
  sourcePath: string
  sidecarPath: string
  transcriptCwd: string
  pendingLineBuffer: string
  redlogIdByUuid: Map<string, string>
  /** v0.7.4 F1: last-seen sibling tool_call command per tool_use_id, so
   *  tool_result emit can gate its output against sensitive-path hints
   *  (`.ssh/`, `.env`, …) via the ACTUAL command, not against the result
   *  string itself. Bounded — LRU-evicted at MAX_TOOL_CMD_CACHE. */
  toolCommandByUseId: Map<string, string>
  /** v0.7.5 G2: children whose parent uuid we haven't ingested yet, keyed
   *  by that parent uuid. Dogfood showed 79 real hits — parent-first isn't
   *  guaranteed. Bounded (MAX_PENDING_CHILDREN) + TTL-swept so late-
   *  arriving parents flush their queue, drops expire cleanly, and a
   *  runaway malformed stream can't exhaust memory. */
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

/** v0.7.4 F1: cap per-session tool-command memoisation. In practice a
 *  session's outstanding tool_use → tool_result window is tiny (a few
 *  turns), but pathological Task-subagent runs could accumulate; LRU-evict
 *  keeps memory bounded regardless. Insertion order is LRU because we use
 *  Map's ordered semantics + delete-and-reinsert on hit. */
const MAX_TOOL_CMD_CACHE = 1000

/** v0.7.5 G2: cap on the pending-parent buffer. 100 chosen to cover
 *  realistic bursts (dogfood test surfaced 79 misses across a
 *  multi-session ingest). Beyond the cap, oldest entries are dropped
 *  with the advisory + emit-without-parent fallback. */
const MAX_PENDING_CHILDREN = 100

/** v0.7.5 G2: how long a child can wait for its parent before we give
 *  up. Real out-of-order arrivals should resolve within a few ms
 *  (chokidar ticks are subsecond); 60s is enormous slack. */
const PENDING_TTL_MS = 60_000

let cfg: AgentTailerConfig = { enabled: false, engagementId: '', operatorId: '' }
let dirWatcher: FSWatcher | null = null
let sessions: Map<string, SessionState> = new Map()

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Resolve the default `~/.claude/projects/` root. Overridable via config
 *  for tests, WSL, or a bespoke Claude Code install location. */
export function resolveDefaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** True if the given cwd contains our self-exclusion marker file. Walked
 *  upward from the cwd so a nested project inside RedLog's tree is also
 *  skipped. Marker file is written by main/index.ts at Electron ready. */
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

/** Read the first line whose parsed JSON has a `cwd` field. The design
 *  review flagged that the *very first* line may be a metadata record
 *  (summary/mode/queue-operation) without cwd, so we scan up to N lines
 *  before giving up. Returns null on IO error or if no cwd found. */
export function readTranscriptCwd(sourcePath: string, maxScanLines = 50): string | null {
  let handle: number
  try { handle = fs.openSync(sourcePath, 'r') } catch { return null }
  try {
    const bufSize = 64 * 1024
    const buf = Buffer.alloc(bufSize)
    let carry = ''
    let scanned = 0
    let offset = 0
    while (scanned < maxScanLines) {
      const n = fs.readSync(handle, buf, 0, bufSize, offset)
      if (n === 0) break
      offset += n
      carry += buf.slice(0, n).toString('utf-8')
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        scanned++
        if (scanned > maxScanLines) break
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd
        } catch { /* skip bad line */ }
      }
    }
  } finally { try { fs.closeSync(handle) } catch { /* ignore */ } }
  return null
}

/** Should this cwd be tailed? Applies the same gate as claude-code-hook.sh
 *  (excludedPaths blacklist, legacy watchPaths whitelist). */
export function cwdPassesGate(cwd: string, excludedPaths?: string[], watchPaths?: string[]): boolean {
  const normalize = (p: string): string => path.resolve(p.replace(/^~/, os.homedir())).replace(/\/$/, '')
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

// ─── Line-type dispatch ─────────────────────────────────────────────────────

interface ParsedTurn {
  uuid: string | null
  parentUuid: string | null
  type: string
  // Fields we bubble up as event data (all optional).
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
  // Content
  textContent?: string          // for user/assistant
  toolName?: string             // for tool_use
  toolUseId?: string            // for tool_use / tool_result
  toolInput?: Record<string, unknown>
  toolOutput?: string           // for tool_result
  hasThinking?: boolean
}

/** Extract a normalized ParsedTurn from a raw transcript line. Returns
 *  null for line types we intentionally skip (KNOWN_IGNORED_TYPES). */
export function parseTranscriptLine(raw: Record<string, unknown>): ParsedTurn | null {
  const type = String(raw.type ?? '')
  if (!KNOWN_INGEST_TYPES.has(type)) return null
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : null
  const parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null
  const message = (raw.message as Record<string, unknown> | undefined) ?? {}
  const role = typeof message.role === 'string' ? message.role : undefined
  const content = message.content
  const t: ParsedTurn = { uuid, parentUuid, type, role }
  // Meta fields (free wins per prior-art research)
  if (typeof raw.isSidechain === 'boolean') t.isSidechain = raw.isSidechain
  if (typeof raw.version === 'string') t.version = raw.version
  if (typeof raw.gitBranch === 'string') t.gitBranch = raw.gitBranch
  if (typeof raw.promptId === 'string') t.promptId = raw.promptId
  if (typeof raw.permissionMode === 'string') t.permissionMode = raw.permissionMode
  if (typeof raw.isCompactSummary === 'boolean') t.isCompactSummary = raw.isCompactSummary
  if (typeof message.model === 'string') t.model = message.model
  const usage = message.usage as Record<string, unknown> | undefined
  if (usage) {
    if (typeof usage.input_tokens === 'number') t.usageTokensIn = usage.input_tokens
    if (typeof usage.output_tokens === 'number') t.usageTokensOut = usage.output_tokens
  }

  // For `tool_result` the payload can live either at message.content (list)
  // OR at toolUseResult (top-level) depending on Claude Code version. We
  // check message.content first; if it's a list of tool_result parts we
  // extract those.
  if (type === 'tool_use' || type === 'tool_result') {
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue
        const cAny = c as Record<string, unknown>
        if (cAny.type === 'tool_use' && type === 'tool_use') {
          t.toolName = typeof cAny.name === 'string' ? cAny.name : undefined
          t.toolUseId = typeof cAny.id === 'string' ? cAny.id : undefined
          t.toolInput = (cAny.input && typeof cAny.input === 'object')
            ? (cAny.input as Record<string, unknown>) : undefined
        }
        if (cAny.type === 'tool_result' && type === 'tool_result') {
          t.toolUseId = typeof cAny.tool_use_id === 'string' ? cAny.tool_use_id : undefined
          const rc = cAny.content
          if (typeof rc === 'string') {
            t.toolOutput = rc
          } else if (Array.isArray(rc)) {
            const parts: string[] = []
            for (const rr of rc) {
              if (rr && typeof rr === 'object' && (rr as Record<string, unknown>).type === 'text') {
                const txt = (rr as Record<string, unknown>).text
                if (typeof txt === 'string') parts.push(txt)
              }
            }
            t.toolOutput = parts.join('\n')
          }
        }
      }
    }
    return t
  }

  // user / assistant text content extraction
  if (Array.isArray(content)) {
    const parts: string[] = []
    let hasThink = false
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const cAny = c as Record<string, unknown>
      if (cAny.type === 'text' && typeof cAny.text === 'string') parts.push(cAny.text)
      else if (cAny.type === 'thinking') hasThink = true
    }
    t.textContent = parts.join('\n')
    if (hasThink) t.hasThinking = true
  } else if (typeof content === 'string') {
    t.textContent = content
  }
  return t
}

// ─── Redaction + cache helpers (v0.7.4 F1 + F3) ─────────────────────────────

/** Recursively walk any JSON-shaped value; redact every string leaf via
 *  `redactSecrets`. Non-strings (numbers/booleans/null) pass through
 *  unchanged. Arrays/objects are cloned (mutating the caller's tool_input
 *  would corrupt subsequent Timeline reads). Cycle-safe via a WeakSet —
 *  Claude Code's tool_input is always JSON.parse output so cycles are
 *  physically impossible, but the guard costs nothing. */
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

/** Extract the "command-shaped" string from a tool_use's input, if any.
 *  Cached per-session (`toolCommandByUseId`) so a later tool_result can
 *  route the correct string through `outputIfPathHiddenByCommand`. Bash
 *  puts it at `command`; file tools name the target `file_path`; MCP
 *  varies; return the first plausible string. */
function pickCommandForCache(toolName: string | undefined, input: Record<string, unknown>): string | null {
  const priority = ['command', 'file_path', 'path', 'url', 'query']
  for (const k of priority) {
    const v = input[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

// ─── Per-turn emit ──────────────────────────────────────────────────────────

interface EmitContext {
  session: SessionState
  cfgSnap: AgentTailerConfig
}

function emitTurn(t: ParsedTurn, ctx: EmitContext): void {
  if (!t.uuid) return  // Can't dedup or link — skip.
  const s = ctx.session
  if (s.redlogIdByUuid.has(t.uuid)) return  // Idempotent — re-read of same line.

  // Resolve parent → RedLog event id for _causes.
  //
  // v0.7.5 G2: Claude Code does NOT strictly write parent-first — a
  // v0.7.4 dogfood test surfaced 79 real misses across a multi-session
  // ingest. The v0.7.2 design's "assert-and-skip" behaviour dropped
  // those chain edges permanently. Now: if the parent hasn't landed
  // yet, buffer this child in `pendingByParentUuid` until the parent
  // arrives (checked at the tail of this function after a successful
  // insert) OR the buffer hits its cap / TTL, at which point we fall
  // back to the old "emit without parent" behaviour + the advisory.
  let causesArr: string[] | undefined
  if (t.parentUuid) {
    const parentRid = s.redlogIdByUuid.get(t.parentUuid)
    if (parentRid) {
      causesArr = [parentRid]
    } else {
      // Prune stale entries from the pending map so a slow parent
      // eventually stops holding late children hostage.
      sweepStalePending(s, ctx.cfgSnap)
      const queue = s.pendingByParentUuid.get(t.parentUuid) ?? []
      if (queue.length + pendingSize(s) < MAX_PENDING_CHILDREN) {
        queue.push({ turn: t, queuedAt: Date.now() })
        s.pendingByParentUuid.set(t.parentUuid, queue)
        return // Wait for the parent — will be emitted when it lands.
      }
      // Buffer full — fall back to the pre-v0.7.5 behaviour: emit without
      // parent, fire the advisory once, keep going.
      if (!s.parentMissingAdvisoryFired) {
        s.parentMissingAdvisoryFired = true
        try {
          const ev = insertEvent('agent', {
            subtype: 'transcript_parent_missing',
            session_id: s.sessionId,
            agent: s.agent,
            parent_uuid: t.parentUuid,
            child_uuid: t.uuid,
            child_type: t.type,
            pending_full: true,
            description: 'Pending-parent buffer full (>' + MAX_PENDING_CHILDREN + '). Later children with missing parents emit without _causes rather than deferring indefinitely.'
          }, { engagementId: ctx.cfgSnap.engagementId, operatorId: ctx.cfgSnap.operatorId })
          if (ev) eventBus.publish(ev)
        } catch (e) { noteDbError('agent-transcript-tailer', e) }
      }
    }
  }

  const subtype = subtypeFor(t)
  if (subtype === 'thinking' && !ctx.cfgSnap.emitThinking) return

  const preview = t.textContent
    ? redactSecrets(t.textContent).slice(0, ctx.cfgSnap.previewChars ?? 500)
    : undefined

  const data: Record<string, unknown> = {
    subtype,
    agent: s.agent,
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
      // v0.7.4 F3: deep-walk every string value under tool_input so
      // Edit.old_string / Edit.new_string / MCP nested args get redacted
      // alongside the top-level [command, content, code, query] that
      // v0.7.2 covered. An operator pasting an API key into `Edit.new_string`
      // used to land unredacted in the events table; now it's redacted
      // like every other string in the payload.
      const redInput = deepRedactStrings(t.toolInput) as Record<string, unknown>
      const inputJson = JSON.stringify(redInput)
      if (Buffer.byteLength(inputJson, 'utf-8') > MAX_FULL_BYTES) {
        data.tool_input_truncated = true
        data.tool_input_length = inputJson.length
        data.tool_input = { _truncated: true, keys: Object.keys(redInput) }
      } else {
        data.tool_input = redInput
      }
      // v0.7.4 F1: remember this tool_use's sibling command so a later
      // tool_result can gate its output against sensitive-path hints.
      // Bounded LRU — delete-and-reinsert on hit keeps recent entries at
      // the tail so eviction removes the coldest key.
      if (t.toolUseId) {
        const cmd = pickCommandForCache(t.toolName, t.toolInput)
        if (cmd) {
          if (ctx.session.toolCommandByUseId.has(t.toolUseId)) ctx.session.toolCommandByUseId.delete(t.toolUseId)
          ctx.session.toolCommandByUseId.set(t.toolUseId, cmd)
          while (ctx.session.toolCommandByUseId.size > MAX_TOOL_CMD_CACHE) {
            const oldest = ctx.session.toolCommandByUseId.keys().next().value
            if (oldest === undefined) break
            ctx.session.toolCommandByUseId.delete(oldest)
          }
        }
      }
      // MCP tool name prefix `mcp__<server>__<tool>` → surface server for free
      if (t.toolName && t.toolName.startsWith('mcp__')) {
        const parts = t.toolName.split('__')
        if (parts.length >= 3) data.mcp_server = parts[1]
      }
    }
  } else if (subtype === 'tool_result') {
    if (t.toolUseId) data.tool_use_id = t.toolUseId
    if (t.toolOutput !== undefined) {
      let output = redactSecrets(t.toolOutput)
      // v0.7.4 F1: look up the sibling tool_call's command via
      // toolCommandByUseId so `outputIfPathHiddenByCommand` gets the
      // ACTUAL command (e.g. `cat ~/.ssh/id_rsa`), not the output
      // itself. Pre-v0.7.4 we passed `output` as both args and the
      // helper checked the OUTPUT for `.ssh/` — meaning key contents
      // leaked whenever they didn't happen to contain the literal
      // path string. Now the check runs against the command; on
      // cache miss (older tool_use evicted or never captured) we
      // apply the helper against the output as a last-ditch pattern
      // scan — same weak fallback as pre-v0.7.4, but now it's
      // explicitly the fallback rather than the only path.
      if (t.toolUseId) {
        const cmd = ctx.session.toolCommandByUseId.get(t.toolUseId)
        if (cmd) {
          output = outputIfPathHiddenByCommand(cmd, output)
        } else {
          output = outputIfPathHiddenByCommand(output, output)
        }
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
      engagementId: ctx.cfgSnap.engagementId,
      operatorId: ctx.cfgSnap.operatorId
    })
    if (ev) {
      s.redlogIdByUuid.set(t.uuid, ev.id)
      s.turnsEmitted++
      eventBus.publish(ev)
      // v0.7.5 G2: any children waiting on this newly-emitted parent
      // can now resolve. Flush the queue for our uuid (if any) and
      // recursively emit them — they may have children of their own.
      const waiting = s.pendingByParentUuid.get(t.uuid)
      if (waiting) {
        s.pendingByParentUuid.delete(t.uuid)
        for (const q of waiting) emitTurn(q.turn, ctx)
      }
    }
  } catch (e) { noteDbError('agent-transcript-tailer', e) }
}

/** v0.7.5 G2: expire queued children whose parent never arrived.
 *  Called at the top of each `emitTurn` that would push into the
 *  buffer, so a slow drift doesn't hold late children hostage.
 *  Dropped entries emit no advisory — this is a best-effort recovery
 *  path, not a hot error signal. */
function sweepStalePending(s: SessionState, _cfgSnap: AgentTailerConfig): void {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [parentUuid, queue] of s.pendingByParentUuid) {
    const alive = queue.filter((q) => q.queuedAt >= cutoff)
    if (alive.length === 0) s.pendingByParentUuid.delete(parentUuid)
    else if (alive.length !== queue.length) s.pendingByParentUuid.set(parentUuid, alive)
  }
}

/** Total pending-child count across all parents. Used by the emitTurn
 *  buffer to enforce MAX_PENDING_CHILDREN as a session-wide cap rather
 *  than per-parent. */
function pendingSize(s: SessionState): number {
  let n = 0
  for (const queue of s.pendingByParentUuid.values()) n += queue.length
  return n
}

function subtypeFor(t: ParsedTurn): string {
  switch (t.type) {
    case 'user': return t.isCompactSummary ? 'compact_summary' : 'user_message'
    case 'assistant': return t.hasThinking && !t.textContent ? 'thinking' : 'assistant_message'
    case 'tool_use': return 'tool_call'
    case 'tool_result': return 'tool_result'
    case 'tool_interrupted': return 'tool_interrupted'
    case 'away_summary': return 'away_summary'
    default: return t.type
  }
}

// ─── Ingest loop ────────────────────────────────────────────────────────────

/** Given a session already registered in `sessions`, catch up its
 *  ingest from `sidecarSize` to `sourceSize`. Handles compaction
 *  (source shrank) by truncating the sidecar and re-emitting a
 *  `transcript_compacted` marker. Public for testability. */
export function catchUpSession(sessionId: string, cfgSnap: AgentTailerConfig): void {
  // v0.7.3 A2: honour the operator's global recording pause. Matches how
  // screenshot-agent, process-monitor, and clipboard-monitor already gate
  // (paused = don't insert anything). File is still on disk — when
  // recording resumes, the next chokidar tick catches up from the sidecar
  // offset, so nothing is lost.
  if (eventBus.paused) return
  const s = sessions.get(sessionId)
  if (!s) return
  let sourceSize: number
  try { sourceSize = fs.statSync(s.sourcePath).size } catch { return }
  let sidecarSize = 0
  try { sidecarSize = fs.statSync(s.sidecarPath).size } catch { /* new — no sidecar yet */ }

  // Compaction / file replacement: source shrank OR our cumulative bytes
  // exceed the current source. Emit a marker + reset sidecar to source
  // head and re-parse. Preserves the audit trail — the "compacted at" event
  // is chained; the old sidecar bytes are gone but their old sha256 is
  // recorded in the marker.
  if (sourceSize < sidecarSize) {
    const oldHash = fileSha256(s.sidecarPath)
    try { fs.truncateSync(s.sidecarPath, 0) } catch { /* new fs will recreate */ }
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
        agent: s.agent,
        old_sidecar_bytes: sidecarSize,
        old_sidecar_sha256: oldHash,
        new_source_bytes: sourceSize,
        description: 'Claude Code truncated the source transcript (likely /compact or /clear). Sidecar reset; subsequent per-turn events are tagged post_compact=true.'
      }, { engagementId: cfgSnap.engagementId, operatorId: cfgSnap.operatorId })
      if (ev) eventBus.publish(ev)
    } catch (e) { noteDbError('agent-transcript-tailer', e) }
    sidecarSize = 0
  }

  if (sourceSize <= sidecarSize) return

  // Read new bytes from source, append to sidecar first, THEN parse and
  // emit per-turn events.
  //
  // v0.7.4 F5: durability discipline the previous comment overstated. The
  // guarantee is **at-most-once with recovery via uuid dedup**, not "no
  // missed events":
  //
  // 1. On sidecar-append then crash BEFORE emit: next tick sees
  //    `sidecarSize == sourceSize` and re-reads nothing — the not-yet-
  //    emitted turns would be lost. That's what F2's registerSession-time
  //    seed of `redlogIdByUuid` from the DB defends against: if we later
  //    re-open the project and the sidecar was truncated/reset,
  //    `catchUpSession` re-parses from head and inserts every uuid it
  //    hasn't already inserted. Turns lost to a crash-during-emit are
  //    only recoverable on a subsequent compaction / manual reset.
  //
  // 2. On sidecar-append then successful emit then process crash: no
  //    corruption. Sidecar reflects committed reads; DB has the events;
  //    next tick's `sidecarSize` correctly advances past them.
  //
  // 3. The opposite order (insert first, append after) would trade in
  //    the other direction: a crash between insert and append leaves
  //    events with no sidecar bytes, and next tick re-reads those same
  //    source bytes and re-inserts. F2's uuid dedup would catch it, but
  //    the extra churn seems worse than the failure mode above.
  //
  // Correct comment. Failure mode documented rather than hidden.
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
  } catch (e) { noteDbError('agent-transcript-tailer', e); return }

  try { fs.appendFileSync(s.sidecarPath, bytes) } catch (e) {
    noteDbError('agent-transcript-tailer', e); return
  }
  s.bytesAppendedSinceSnapshot += bytes.length

  // Parse new bytes, joined with any trailing partial from last tick.
  const text = s.pendingLineBuffer + bytes.toString('utf-8')
  const lastNl = text.lastIndexOf('\n')
  const complete = lastNl === -1 ? '' : text.slice(0, lastNl)
  s.pendingLineBuffer = lastNl === -1 ? text : text.slice(lastNl + 1)

  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    s.linesSeen++
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) } catch {
      // Malformed line — don't crash, count as drift. We don't reset the
      // whole session because Claude Code sometimes writes partial JSON
      // during heavy load and completes it later; the next tick will
      // re-read from `lastNl+1` position. In practice this should be rare
      // once the partial-line buffer is in place.
      continue
    }
    // Detect unknown line types once per session (schema drift advisory).
    const rawType = String(raw.type ?? '')
    if (!KNOWN_INGEST_TYPES.has(rawType) && !KNOWN_IGNORED_TYPES.has(rawType) && !s.driftAdvisoryFired) {
      s.driftAdvisoryFired = true
      try {
        const ev = insertEvent('agent', {
          subtype: 'transcript_schema_drift',
          session_id: s.sessionId,
          agent: s.agent,
          unknown_type: rawType,
          description: 'Encountered a transcript line type not in the tailer whitelist. Ingesting the file continues; only this novel type is skipped. Update KNOWN_INGEST_TYPES / KNOWN_IGNORED_TYPES to cover it if needed.'
        }, { engagementId: cfgSnap.engagementId, operatorId: cfgSnap.operatorId })
        if (ev) eventBus.publish(ev)
      } catch (e) { noteDbError('agent-transcript-tailer', e) }
      continue
    }
    const turn = parseTranscriptLine(raw)
    if (!turn) continue
    emitTurn(turn, { session: s, cfgSnap })
  }

  // Reset idle timer — snapshot fires 15s after last activity.
  scheduleIdleSnapshot(s, cfgSnap)
}

function scheduleIdleSnapshot(s: SessionState, cfgSnap: AgentTailerConfig): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null
    emitSnapshot(s, cfgSnap, 'idle')
  }, cfgSnap.idleFlushMs ?? 15_000)
}

function emitSnapshot(s: SessionState, cfgSnap: AgentTailerConfig, reason: 'idle' | 'session_close' | 'periodic'): void {
  if (s.bytesAppendedSinceSnapshot === 0 && reason === 'idle') return
  let sidecarSize = 0
  try { sidecarSize = fs.statSync(s.sidecarPath).size } catch { return }
  const sha = fileSha256(s.sidecarPath)
  try {
    const ev = insertEvent('agent', {
      subtype: 'transcript_snapshot',
      session_id: s.sessionId,
      agent: s.agent,
      snapshot_path: s.sidecarPath,
      cumulative_bytes: sidecarSize,
      cumulative_sha256: sha,
      line_count: s.linesSeen,
      turns_emitted: s.turnsEmitted,
      reason
    }, { engagementId: cfgSnap.engagementId, operatorId: cfgSnap.operatorId })
    if (ev) eventBus.publish(ev)
  } catch (e) { noteDbError('agent-transcript-tailer', e) }
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

/** Add a session to the watch set. Idempotent — calling twice with the
 *  same source path is a no-op. Public for testability + so main can
 *  invoke on chokidar `add` events too. */
export function registerSession(sourcePath: string, cfgSnap: AgentTailerConfig): void {
  const sessionId = path.basename(sourcePath, '.jsonl')
  if (sessions.has(sessionId)) return
  const cwd = readTranscriptCwd(sourcePath)
  if (!cwd) return
  if (isSelfExcludedCwd(cwd, cfgSnap.selfExclusionMarker ?? '.redlog-app-root')) return
  if (!cwdPassesGate(cwd, cfgSnap.excludedPaths, cfgSnap.watchPaths)) return
  let projectDir: string
  try { projectDir = getProjectDir() } catch { return }
  const sidecarDir = path.join(projectDir, 'agent-transcripts')
  try { fs.mkdirSync(sidecarDir, { recursive: true }) } catch { /* ignore */ }
  const sidecarPath = path.join(sidecarDir, `claude-code-${sessionId}.jsonl`)
  // Sanity: sidecar must resolve inside projectDir. Guards against a
  // sessionId containing path-traversal characters (Claude Code uses
  // UUIDs so this should never fail, but the constraint is cheap).
  if (!isInsideDir(sidecarDir, sidecarPath)) return
  const s: SessionState = {
    sessionId,
    agent: 'claude-code',
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
  sessions.set(sessionId, s)
  // v0.7.4 F2: seed `redlogIdByUuid` from prior events already in the DB
  // for this session — dedupes across process restarts and across sidecar
  // retention prune. Without this, pruning the sidecar (retention default
  // 30d) then reopening the project would re-insert every historical turn
  // as fresh chained events, polluting the chain with duplicates.
  try {
    const db = getDB()
    const rows = db.prepare(
      `SELECT id, json_extract(data, '$.transcript_uuid') AS uuid
         FROM events
        WHERE agent_type = 'agent'
          AND json_extract(data, '$.session_id') = ?
          AND json_extract(data, '$.agent') = 'claude-code'
          AND json_extract(data, '$.transcript_uuid') IS NOT NULL`
    ).all(sessionId) as Array<{ id: string; uuid: string }>
    for (const row of rows) s.redlogIdByUuid.set(row.uuid, row.id)
  } catch (e) { noteDbError('agent-transcript-tailer', e) }
  catchUpSession(sessionId, cfgSnap)
}

function unregisterSession(sessionId: string, cfgSnap: AgentTailerConfig): void {
  const s = sessions.get(sessionId)
  if (!s) return
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null }
  // v0.7.4 F4: honour the operator's global recording pause here too. Pre-
  // v0.7.4, catchUpSession gated on `eventBus.paused` but this teardown
  // path wrote both a snapshot AND a session_end even while paused —
  // violating the "matches other capture services' pause behaviour"
  // contract the v0.7.3 A2 comment set out. Sessions still get removed
  // from the in-memory map so a subsequent resume + re-register picks up
  // cleanly; we just don't insert events during the pause window.
  if (!eventBus.paused) {
    emitSnapshot(s, cfgSnap, 'session_close')
    // v0.7.3 A2: emit an explicit `agent.session_end` terminus so chain-anchor
    // walks (verifyChainFull) have a clean boundary per session. Without this,
    // the last per-turn event's `_causes` graph has a hanging leaf and the
    // Timeline's session-boundary dividers (v0.6.90 E) can't render for
    // agent sessions the same way they do for shell sessions.
    try {
      const ev = insertEvent('agent', {
        subtype: 'session_end',
        agent: s.agent,
        session_id: s.sessionId,
        turns_emitted: s.turnsEmitted,
        lines_seen: s.linesSeen,
        description: 'Transcript source file unlinked or tailer shutting down; no more events will land for this session.'
      }, { engagementId: cfgSnap.engagementId, operatorId: cfgSnap.operatorId })
      if (ev) eventBus.publish(ev)
    } catch (e) { noteDbError('agent-transcript-tailer', e) }
  }
  sessions.delete(sessionId)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function configureAgentTailer(next: Partial<AgentTailerConfig>): void {
  cfg = { ...cfg, ...next }
  restart()
}

export function startAgentTailer(next?: Partial<AgentTailerConfig>): void {
  if (next) cfg = { ...cfg, ...next }
  restart()
}

export function stopAgentTailer(): void {
  if (dirWatcher) { void dirWatcher.close(); dirWatcher = null }
  for (const [sid] of sessions) unregisterSession(sid, cfg)
  sessions.clear()
}

function restart(): void {
  stopAgentTailer()
  if (!cfg.enabled) return
  if (!cfg.engagementId || !cfg.operatorId) return
  const root = cfg.claudeProjectsDir || resolveDefaultClaudeDir()
  if (!fs.existsSync(root)) return
  // Watch the whole projects dir. chokidar's `awaitWriteFinish` off; we
  // do our own partial-line handling. `depth` limited so a novel deep
  // Claude Code layout doesn't recurse forever.
  dirWatcher = chokidar.watch(root, {
    ignored: (p) => !p.endsWith('.jsonl') && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory(),
    persistent: true,
    ignoreInitial: false,
    depth: 4,
    awaitWriteFinish: false
  })
  dirWatcher.on('add', (p) => { if (p.endsWith('.jsonl')) registerSession(p, cfg) })
  dirWatcher.on('change', (p) => {
    if (!p.endsWith('.jsonl')) return
    const sid = path.basename(p, '.jsonl')
    if (sessions.has(sid)) catchUpSession(sid, cfg)
    else registerSession(p, cfg)
  })
  dirWatcher.on('unlink', (p) => {
    if (!p.endsWith('.jsonl')) return
    const sid = path.basename(p, '.jsonl')
    unregisterSession(sid, cfg)
  })
}

// Test-only introspection.
export function _sessionsForTest(): Map<string, SessionState> {
  return sessions
}
