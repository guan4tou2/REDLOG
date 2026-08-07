// v0.8.0 A — Claude Code adapter for the tailer host.
//
// Historical: v0.7.2 introduced this file as a monolithic 973-LOC
// service that owned both the Claude-Code-specific JSONL parsing AND
// the generic sidecar/redaction/insertEvent/snapshot/lifecycle plumbing.
// v0.8.0 extracts the generic parts into `tailer-host.ts` so a future
// Codex / OpenCode / third-party fork can plug in a `TailerAdapter`
// against the same infrastructure without duplicating 500 LOC of
// chokidar + sidecar + hash-chain wiring.
//
// This file now:
//   1. Defines the Claude-Code-specific line-type whitelist + parser
//      (`parseTranscriptLine`, `KNOWN_INGEST_TYPES`, `KNOWN_IGNORED_TYPES`).
//   2. Assembles a `claudeCodeAdapter: TailerAdapter` object.
//   3. Re-exports `configureAgentTailer` / `startAgentTailer` /
//      `stopAgentTailer` names as thin wrappers around the host's
//      `configureHost` / `startHost` / `stopHost`, so `main/index.ts`
//      is unchanged.
//
// v0.8.0 C moves this file into `plugins/claude-code-tailer/` as a
// bundled plugin; the plugin API contract (v0.8.0 B) is what makes the
// physical relocation trivial.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  configureHost, startHost, stopHost, registerAdapter,
  isSelfExcludedCwd, cwdPassesGate,
  catchUpSession as hostCatchUpSession,
  registerSession as hostRegisterSession,
  type TailerAdapter, type TailerHostConfig, type ParsedTurn,
  _sessionsForTest
} from './tailer-host'

// ─── Public config surface (unchanged from v0.7.x for main/index.ts) ────────

export interface AgentTailerConfig extends TailerHostConfig {
  /** Root of Claude Code's per-session transcripts. Overridable for tests
   *  and for cross-platform paths. */
  claudeProjectsDir?: string
}

// ─── Claude-Code-specific constants ─────────────────────────────────────────

const KNOWN_INGEST_TYPES = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'tool_interrupted',
  'away_summary'
])

const KNOWN_IGNORED_TYPES = new Set([
  'summary',
  'custom-title',
  'mode',
  'queue-operation',
  'attachment',
  'system',
  'meta',
  // v0.7.5 G1 + v0.7.6 H1: real Claude Code metadata line types
  // observed in dogfood — silence schema-drift advisories.
  'last-prompt',
  'frame-link',
  'pr-link'
])

// ─── Path helpers (Claude-format specific) ──────────────────────────────────

export function resolveDefaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** Read the first line whose parsed JSON has a `cwd` field. Metadata
 *  records (`summary`, `mode`, etc.) may lead — scan up to N units. */
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

// ─── Line parser (Claude Code JSONL schema) ─────────────────────────────────

export function parseTranscriptLine(raw: Record<string, unknown>): ParsedTurn | null {
  const type = String(raw.type ?? '')
  if (!KNOWN_INGEST_TYPES.has(type)) {
    // Also return non-null for ignored types so the host can distinguish
    // "recognised but skipped" (return with `type` in ignored set) from
    // "unknown type" (return with `type` outside both). The host's
    // schema-drift check is keyed off knownIngestTypes only, so returning
    // an ignored-type turn here is safe — it'll get skipped by
    // `!knownIngestTypes.has(turn.type)` and NOT fire the drift advisory
    // because the type is in `knownIgnoredTypes`.
    if (KNOWN_IGNORED_TYPES.has(type)) return null
    // Unknown-and-not-ignored: return a stub so host fires drift advisory.
    return { uuid: null, parentUuid: null, type }
  }
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : null
  const parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null
  const message = (raw.message as Record<string, unknown> | undefined) ?? {}
  const role = typeof message.role === 'string' ? message.role : undefined
  const content = message.content
  const t: ParsedTurn = { uuid, parentUuid, type, role }
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

// ─── Subtype mapping (Claude type → RedLog event subtype) ───────────────────

function subtypeForClaude(t: ParsedTurn): string {
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

// ─── Claude Code adapter object ─────────────────────────────────────────────

export const claudeCodeAdapter: TailerAdapter = {
  agentKind: 'claude-code',
  transcriptGlob: '~/.claude/projects/**/*.jsonl',
  perMessageDir: false,
  knownIngestTypes: KNOWN_INGEST_TYPES,
  knownIgnoredTypes: KNOWN_IGNORED_TYPES,
  resolveCwd(sourcePath: string): string | null {
    return readTranscriptCwd(sourcePath)
  },
  parseUnit(rawContent: string): ParsedTurn | null {
    try {
      const obj = JSON.parse(rawContent) as Record<string, unknown>
      return parseTranscriptLine(obj)
    } catch { return null }
  },
  // Claude's `/compact` inserts a shorter head; source-shrink detection is
  // the default host behaviour, so no override needed.
  subtypeFor: subtypeForClaude
}

// ─── Public API — thin wrappers preserving v0.7.x names ─────────────────────

let claudeRegistered = false

export function configureAgentTailer(next: Partial<AgentTailerConfig>): void {
  ensureClaudeRegistered()
  const { claudeProjectsDir, ...hostCfg } = next
  // claudeProjectsDir override support: if provided, patch the adapter's
  // transcriptGlob before configuring the host so tests can point at a
  // scratch dir.
  if (claudeProjectsDir) {
    ;(claudeCodeAdapter as { transcriptGlob: string }).transcriptGlob =
      path.join(claudeProjectsDir, '**', '*.jsonl')
  }
  configureHost(hostCfg)
}

export function startAgentTailer(next?: Partial<AgentTailerConfig>): void {
  ensureClaudeRegistered()
  const { claudeProjectsDir, ...hostCfg } = next ?? {}
  if (claudeProjectsDir) {
    ;(claudeCodeAdapter as { transcriptGlob: string }).transcriptGlob =
      path.join(claudeProjectsDir, '**', '*.jsonl')
  }
  startHost(hostCfg)
}

export function stopAgentTailer(): void {
  stopHost()
}

function ensureClaudeRegistered(): void {
  if (claudeRegistered) return
  registerAdapter(claudeCodeAdapter)
  claudeRegistered = true
}

// ─── Test compatibility re-exports (kept for existing tests) ────────────────

export {
  isSelfExcludedCwd, cwdPassesGate, _sessionsForTest
}
export function catchUpSession(sessionId: string, _cfgSnap?: AgentTailerConfig): void {
  // v0.8.0 A: kept for test compat. Real work delegated to host.
  hostCatchUpSession(sessionId)
}
export function registerSession(sourcePath: string, cfgSnap?: AgentTailerConfig): void {
  // Test-mode helper: honour claudeProjectsDir override + then hand off to
  // the host's registerSession under 'claude-code'.
  ensureClaudeRegistered()
  if (cfgSnap) configureHost({
    engagementId: cfgSnap.engagementId,
    operatorId: cfgSnap.operatorId,
    excludedPaths: cfgSnap.excludedPaths,
    watchPaths: cfgSnap.watchPaths,
    selfExclusionMarker: cfgSnap.selfExclusionMarker,
    idleFlushMs: cfgSnap.idleFlushMs,
    previewChars: cfgSnap.previewChars,
    emitThinking: cfgSnap.emitThinking,
    enabled: true
  })
  hostRegisterSession('claude-code', sourcePath)
}
