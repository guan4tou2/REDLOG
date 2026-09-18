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
  configureHost, startHost, stopHost, registerAdapter, setHostConfig,
  isSelfExcludedCwd, cwdPassesGate,
  catchUpSession as hostCatchUpSession,
  registerSession as hostRegisterSession,
  type TailerAdapter, type TailerHostConfig, type ParsedTurn,
  _sessionsForTest
} from './tailer-host'
import { codexAdapter, overrideCodexTranscriptRoot } from './adapters/codex'
import { opencodeAdapter, overrideOpencodeStorageRoot } from './adapters/opencode'

// ─── Public config surface (unchanged from v0.7.x for main/index.ts) ────────

export interface AgentTailerConfig extends TailerHostConfig {
  /** Root of Claude Code's per-session transcripts. Overridable for tests
   *  and for cross-platform paths. */
  claudeProjectsDir?: string
  /** Root of Codex CLI's session rollouts (default `~/.codex/sessions`).
   *  v0.8.1: overridable for tests only — no user-facing config yet. */
  codexSessionsDir?: string
  /** Root of OpenCode storage dir (default
   *  `~/.local/share/opencode/storage`). v0.8.1: test-only override. */
  opencodeStorageDir?: string
}

// ─── Claude-Code-specific constants ─────────────────────────────────────────

const KNOWN_INGEST_TYPES = new Set([
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'tool_interrupted',
  'away_summary',
  'system'
])

const KNOWN_IGNORED_TYPES = new Set([
  'summary',
  'custom-title',
  'mode',
  'queue-operation',
  'attachment',
  'meta',
  // v0.7.5 G1 + v0.7.6 H1: real Claude Code metadata line types
  // observed in dogfood — silence schema-drift advisories.
  'last-prompt',
  'frame-link',
  'pr-link',
  // P2-6: observed in current Claude Code transcripts — suppress false
  // drift advisories. bridge-session and file-history-* may warrant
  // ingest in a future pass.
  'bridge-session',
  'atis-latch',
  'agent-name',
  'file-history-delta',
  'file-history-snapshot',
  'stop_hook_summary'
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
      for (const raw of parts) {
        scanned++
        if (scanned > maxScanLines) break
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (!line) continue
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

export function parseTranscriptLine(raw: Record<string, unknown>): ParsedTurn | ParsedTurn[] | null {
  const type = String(raw.type ?? '')
  if (!KNOWN_INGEST_TYPES.has(type)) {
    if (KNOWN_IGNORED_TYPES.has(type)) return null
    return { uuid: null, parentUuid: null, type }
  }
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : null
  const parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null
  const message = (raw.message as Record<string, unknown> | undefined) ?? {}
  const role = typeof message.role === 'string' ? message.role : undefined
  const content = message.content
  // Audit 2026-09-18 P2: capture source timestamp from the transcript line.
  const sourceTimestamp = typeof raw.timestamp === 'number' ? raw.timestamp
    : (typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) || undefined : undefined)

  /** Shared metadata fields applied to every turn from this line. */
  function applyMeta(t: ParsedTurn): ParsedTurn {
    if (typeof raw.isSidechain === 'boolean') t.isSidechain = raw.isSidechain
    if (typeof raw.version === 'string') t.version = raw.version
    if (typeof raw.gitBranch === 'string') t.gitBranch = raw.gitBranch
    if (typeof raw.promptId === 'string') t.promptId = raw.promptId
    if (typeof raw.permissionMode === 'string') t.permissionMode = raw.permissionMode
    if (typeof raw.isCompactSummary === 'boolean') t.isCompactSummary = raw.isCompactSummary
    if (typeof message.model === 'string') t.model = message.model
    if (typeof sourceTimestamp === 'number') t.sourceTimestamp = sourceTimestamp
    const usage = message.usage as Record<string, unknown> | undefined
    if (usage) {
      if (typeof usage.input_tokens === 'number') t.usageTokensIn = usage.input_tokens
      if (typeof usage.output_tokens === 'number') t.usageTokensOut = usage.output_tokens
      if (typeof usage.cache_creation_input_tokens === 'number') t.usageCacheCreation = usage.cache_creation_input_tokens
      if (typeof usage.cache_read_input_tokens === 'number') t.usageCacheRead = usage.cache_read_input_tokens
      const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined
      if (outputDetails && typeof outputDetails.thinking_tokens === 'number') t.usageThinkingTokens = outputDetails.thinking_tokens
    }
    if (typeof message.service_tier === 'string') t.serviceTier = message.service_tier
    if (typeof message.stop_reason === 'string') t.stopReason = message.stop_reason
    return t
  }

  // Audit 2026-09-18 P2-3: capture model refusals, API errors, permission decisions.
  if (type === 'system') {
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : ''
    const INGESTED_SUBTYPES = new Set(['model_refusal_fallback', 'model_refusal_no_fallback', 'api_error'])
    if (!INGESTED_SUBTYPES.has(subtype)) return null
    const t: ParsedTurn = applyMeta({ uuid, parentUuid, type, role })
    t.systemSubtype = subtype
    if (typeof raw.apiRefusalCategory === 'string') t.refusalCategory = raw.apiRefusalCategory
    if (typeof raw.apiRefusalExplanation === 'string') t.refusalExplanation = raw.apiRefusalExplanation
    if (typeof raw.direction === 'string') t.refusalDirection = raw.direction
    if (typeof raw.originalModel === 'string') t.originalModel = raw.originalModel
    if (typeof raw.fallbackModel === 'string') t.fallbackModel = raw.fallbackModel
    if (typeof raw.errorType === 'string') t.errorType = raw.errorType
    if (typeof raw.errorMessage === 'string') t.errorMessage = raw.errorMessage
    return t
  }

  // Audit 2026-09-18 P2: multi-tool fix. A single JSONL line can carry N
  // tool_use or tool_result blocks in its content array. The old code iterated
  // the array and overwrote a single ParsedTurn on each hit, so only the LAST
  // block survived. Now we collect one ParsedTurn per block and return the
  // array; the host's processUnit already handles ParsedTurn[].
  if (type === 'tool_use' || type === 'tool_result') {
    if (Array.isArray(content)) {
      const turns: ParsedTurn[] = []
      for (const c of content) {
        if (!c || typeof c !== 'object') continue
        const cAny = c as Record<string, unknown>
        if (cAny.type === 'tool_use' && type === 'tool_use') {
          turns.push(applyMeta({
            uuid: turns.length === 0 ? uuid : (uuid ? `${uuid}:tu${turns.length}` : null),
            parentUuid,
            type: 'tool_use',
            role,
            toolName: typeof cAny.name === 'string' ? cAny.name : undefined,
            toolUseId: typeof cAny.id === 'string' ? cAny.id : undefined,
            toolInput: (cAny.input && typeof cAny.input === 'object')
              ? (cAny.input as Record<string, unknown>) : undefined
          }))
        }
        if (cAny.type === 'tool_result' && type === 'tool_result') {
          let toolOutput: string | undefined
          let imgCount = 0
          const rc = cAny.content
          if (typeof rc === 'string') {
            toolOutput = rc
          } else if (Array.isArray(rc)) {
            const parts: string[] = []
            for (const rr of rc) {
              if (rr && typeof rr === 'object') {
                if ((rr as Record<string, unknown>).type === 'text') {
                  const txt = (rr as Record<string, unknown>).text
                  if (typeof txt === 'string') parts.push(txt)
                } else if ((rr as Record<string, unknown>).type === 'image') {
                  imgCount++
                }
              }
            }
            toolOutput = parts.join('\n')
          }
          const trTurn: ParsedTurn = applyMeta({
            uuid: turns.length === 0 ? uuid : (uuid ? `${uuid}:tr${turns.length}` : null),
            parentUuid,
            type: 'tool_result',
            role,
            toolUseId: typeof cAny.tool_use_id === 'string' ? cAny.tool_use_id : undefined,
            toolOutput
          })
          if (imgCount > 0) trTurn.imageBlockCount = imgCount
          turns.push(trTurn)
        }
      }
      if (turns.length === 0) return applyMeta({ uuid, parentUuid, type, role })
      if (turns.length === 1) return turns[0]
      return turns
    }
    return applyMeta({ uuid, parentUuid, type, role })
  }

  // Assistant / user lines: may embed tool blocks alongside text.
  if (Array.isArray(content)) {
    const parts: string[] = []
    let hasThink = false
    const toolTurns: ParsedTurn[] = []
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const cAny = c as Record<string, unknown>
      if (cAny.type === 'text' && typeof cAny.text === 'string') parts.push(cAny.text)
      else if (cAny.type === 'thinking') hasThink = true
      else if (cAny.type === 'tool_use' && type === 'assistant') {
        toolTurns.push(applyMeta({
          uuid: uuid ? `${uuid}:tu${toolTurns.length}` : null,
          parentUuid: uuid,
          type: 'tool_use',
          role,
          toolName: typeof cAny.name === 'string' ? cAny.name : undefined,
          toolUseId: typeof cAny.id === 'string' ? cAny.id : undefined,
          toolInput: (cAny.input && typeof cAny.input === 'object')
            ? (cAny.input as Record<string, unknown>) : undefined
        }))
      } else if (cAny.type === 'tool_result' && type === 'user') {
        let toolOutput: string | undefined
        let imgCount = 0
        const rc = cAny.content
        if (typeof rc === 'string') {
          toolOutput = rc
        } else if (Array.isArray(rc)) {
          const rParts: string[] = []
          for (const rr of rc) {
            if (rr && typeof rr === 'object') {
              if ((rr as Record<string, unknown>).type === 'text') {
                const txt = (rr as Record<string, unknown>).text
                if (typeof txt === 'string') rParts.push(txt)
              } else if ((rr as Record<string, unknown>).type === 'image') {
                imgCount++
              }
            }
          }
          toolOutput = rParts.join('\n')
        }
        const trTurn: ParsedTurn = applyMeta({
          uuid: uuid ? `${uuid}:tr${toolTurns.length}` : null,
          parentUuid: uuid,
          type: 'tool_result',
          role,
          toolUseId: typeof cAny.tool_use_id === 'string' ? cAny.tool_use_id : undefined,
          toolOutput
        })
        if (imgCount > 0) trTurn.imageBlockCount = imgCount
        toolTurns.push(trTurn)
      }
    }
    const t: ParsedTurn = applyMeta({ uuid, parentUuid, type, role })
    t.textContent = parts.join('\n')
    if (hasThink) t.hasThinking = true
    // P2-3: extract permission decision fields from user-type lines.
    if (type === 'user') {
      if (typeof raw.toolDenialKind === 'string') t.toolDenialKind = raw.toolDenialKind
      if (typeof raw.toolResultRemedy === 'string') t.toolResultRemedy = raw.toolResultRemedy
    }
    if (toolTurns.length === 0) return t
    return [t, ...toolTurns]
  } else if (typeof content === 'string') {
    const t: ParsedTurn = applyMeta({ uuid, parentUuid, type, role })
    t.textContent = content
    // P2-3: extract permission decision fields from user-type lines.
    if (type === 'user') {
      if (typeof raw.toolDenialKind === 'string') t.toolDenialKind = raw.toolDenialKind
      if (typeof raw.toolResultRemedy === 'string') t.toolResultRemedy = raw.toolResultRemedy
    }
    return t
  }
  const fallback: ParsedTurn = applyMeta({ uuid, parentUuid, type, role })
  // P2-3: extract permission decision fields from user-type lines.
  if (type === 'user') {
    if (typeof raw.toolDenialKind === 'string') fallback.toolDenialKind = raw.toolDenialKind
    if (typeof raw.toolResultRemedy === 'string') fallback.toolResultRemedy = raw.toolResultRemedy
  }
  return fallback
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
    case 'system': {
      if (t.systemSubtype?.startsWith('model_refusal')) return 'model_refusal'
      if (t.systemSubtype === 'api_error') return 'api_error'
      return t.systemSubtype ?? 'system'
    }
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
  parseUnit(rawContent: string): ParsedTurn | ParsedTurn[] | null {
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

let adaptersRegistered = false

function applyGlobOverrides(next: Partial<AgentTailerConfig>): Partial<TailerHostConfig> {
  const { claudeProjectsDir, codexSessionsDir, opencodeStorageDir, ...hostCfg } = next
  if (claudeProjectsDir) {
    ;(claudeCodeAdapter as { transcriptGlob: string }).transcriptGlob =
      path.join(claudeProjectsDir, '**', '*.jsonl')
  }
  if (codexSessionsDir) overrideCodexTranscriptRoot(codexSessionsDir)
  if (opencodeStorageDir) overrideOpencodeStorageRoot(opencodeStorageDir)
  return hostCfg
}

export function configureAgentTailer(next: Partial<AgentTailerConfig>): void {
  const hostCfg = applyGlobOverrides(next)
  ensureAdaptersRegistered()
  configureHost(hostCfg)
}

export function startAgentTailer(next?: Partial<AgentTailerConfig>): void {
  const hostCfg = applyGlobOverrides(next ?? {})
  ensureAdaptersRegistered()
  startHost(hostCfg)
}

export function stopAgentTailer(): void {
  stopHost()
}

function ensureAdaptersRegistered(): void {
  if (adaptersRegistered) return
  registerAdapter(claudeCodeAdapter)
  registerAdapter(codexAdapter)
  registerAdapter(opencodeAdapter)
  adaptersRegistered = true
}

// ─── Test compatibility re-exports (kept for existing tests) ────────────────

export {
  isSelfExcludedCwd, cwdPassesGate, _sessionsForTest
}
export function catchUpSession(sessionId: string, _cfgSnap?: AgentTailerConfig): void {
  // v0.8.0 A: kept for test compat. Real work delegated to host.
  hostCatchUpSession('claude-code', sessionId)
}
export function registerSession(sourcePath: string, cfgSnap?: AgentTailerConfig): void {
  // Test-mode helper: honour claudeProjectsDir override + then hand off to
  // the host's registerSession under 'claude-code'.
  //
  // v0.8.0.1 F2: use setHostConfig (mutate-only) instead of configureHost
  // (mutate + restartAll). The old shim's configureHost call would
  // stopHost() every live session and emit a spurious `session_end` for
  // each — corrupting the audit trail for tests that register two
  // sessions in sequence.
  if (cfgSnap?.claudeProjectsDir) {
    ;(claudeCodeAdapter as { transcriptGlob: string }).transcriptGlob =
      path.join(cfgSnap.claudeProjectsDir, '**', '*.jsonl')
  }
  ensureAdaptersRegistered()
  if (cfgSnap) setHostConfig({
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
