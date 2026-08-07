// Codex CLI transcript adapter for the tailer host (v0.8.1 A).
//
// Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
//   Each line is `{timestamp, type, payload}`.
//   - First line: `{type: 'session_meta', payload: {cwd, id, model_provider, cli_version, ...}}`
//   - Content:   `{type: 'response_item', payload: {type: <kind>, ...}}`
//     where <kind> is one of `message`, `agent_message`, `user_message`,
//     `function_call`, `function_call_output`, `reasoning`,
//     `context_compacted`, `custom_tool_call`, `custom_tool_call_output`,
//     `web_search_call`, `web_search_end`, `patch_apply_end`,
//     `exec_command_end`.
//
// Codex has NO transcript-level uuid or parentUuid — the wire format is
// positional. We synthesise uuids so the host's dedup + `_causes` logic
// still works:
//   - `function_call`             → uuid `codex:fc:<call_id>`
//   - `function_call_output`      → uuid `codex:fco:<call_id>`,
//                                    parentUuid `codex:fc:<call_id>`
//   - anything else               → uuid `codex:<sha256_short(raw)>`
// Two byte-identical lines dedup to one event — desired, they'd carry
// identical content anyway.

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { TailerAdapter, ParsedTurn } from '../tailer-host'

// Payload types we ingest as per-turn events.
export const CODEX_INGEST_TYPES = new Set([
  'message',
  'agent_message',
  'user_message',
  'function_call',
  'function_call_output',
  'reasoning',
  'context_compacted',
  'custom_tool_call',
  'custom_tool_call_output',
  'web_search_call',
  'web_search_end',
  'patch_apply_end',
  'exec_command_end',
  // Special: we DO ingest session_meta so the host's schema-drift check
  // doesn't fire on the first line. We just skip emitting it (subtype
  // returned as null-ish is filtered at emitTurn time via `uuid: null`).
  'session_meta'
])

// Payload types we recognise but deliberately skip.
export const CODEX_IGNORED_TYPES = new Set([
  'task_started',
  'task_complete',
  'thread_name_updated',
  'token_count'
])

function sha256Short(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/** Scan the first N lines of a Codex rollout for its `session_meta`
 *  header and return its `payload.cwd`. */
export function readCodexCwd(sourcePath: string, maxScanLines = 20): string | null {
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
          const obj = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } }
          if (obj.type === 'session_meta' && typeof obj.payload?.cwd === 'string') {
            return obj.payload.cwd
          }
        } catch { /* skip bad line */ }
      }
    }
  } finally { try { fs.closeSync(handle) } catch { /* ignore */ } }
  return null
}

/** Parse one Codex JSONL line. */
export function parseCodexLine(raw: string): ParsedTurn | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) as Record<string, unknown> } catch { return null }
  const topType = String(obj.type ?? '')
  // session_meta is the header — we know about it, but we don't emit it
  // as an event. Return a turn with null uuid so processUnit's ingest
  // whitelist check passes, and emitTurn's `if (!t.uuid) return` filters.
  if (topType === 'session_meta') return { uuid: null, parentUuid: null, type: 'session_meta' }
  if (topType !== 'response_item') {
    // Unknown top-level type — let host fire drift advisory once.
    return { uuid: null, parentUuid: null, type: topType }
  }
  const payload = (obj.payload as Record<string, unknown> | undefined) ?? {}
  const payloadType = String(payload.type ?? '')
  if (CODEX_IGNORED_TYPES.has(payloadType)) return null

  const t: ParsedTurn = { uuid: null, parentUuid: null, type: payloadType }

  // Route by kind.
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null
    t.uuid = callId ? `codex:fc:${callId}` : `codex:${sha256Short(raw)}`
    t.toolName = typeof payload.name === 'string' ? payload.name : undefined
    t.toolUseId = callId ?? undefined
    if (typeof payload.arguments === 'string') {
      try {
        t.toolInput = JSON.parse(payload.arguments) as Record<string, unknown>
      } catch { t.toolInput = { _raw: payload.arguments } }
    } else if (payload.arguments && typeof payload.arguments === 'object') {
      t.toolInput = payload.arguments as Record<string, unknown>
    }
    return t
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null
    t.uuid = callId ? `codex:fco:${callId}` : `codex:${sha256Short(raw)}`
    t.parentUuid = callId ? `codex:fc:${callId}` : null
    t.toolUseId = callId ?? undefined
    if (typeof payload.output === 'string') t.toolOutput = payload.output
    else if (payload.output && typeof payload.output === 'object') {
      try { t.toolOutput = JSON.stringify(payload.output) } catch { /* ignore */ }
    }
    return t
  }

  if (payloadType === 'web_search_call' || payloadType === 'web_search_end' ||
      payloadType === 'patch_apply_end' || payloadType === 'exec_command_end') {
    t.uuid = `codex:${sha256Short(raw)}`
    t.toolName = payloadType
    const anyPayload = payload as Record<string, unknown>
    if (typeof anyPayload.query === 'string') t.toolInput = { query: anyPayload.query }
    if (typeof anyPayload.command === 'string') t.toolInput = { command: anyPayload.command }
    if (typeof anyPayload.output === 'string') t.toolOutput = anyPayload.output
    return t
  }

  if (payloadType === 'reasoning') {
    t.uuid = `codex:${sha256Short(raw)}`
    t.hasThinking = true
    // Codex reasoning is `encrypted_content` — an opaque blob. We surface
    // the length via a synthetic textContent so the snapshot line-count
    // reflects work done, but the sidecar keeps the encrypted form as-is.
    const summary = payload.summary
    if (Array.isArray(summary) && summary.length) {
      t.textContent = summary.map((s) => (s && typeof s === 'object' && 'text' in (s as object))
        ? String((s as { text: unknown }).text)
        : '').filter(Boolean).join('\n')
    }
    return t
  }

  if (payloadType === 'context_compacted') {
    t.uuid = `codex:${sha256Short(raw)}`
    t.isCompactSummary = true
    return t
  }

  if (payloadType === 'message' || payloadType === 'agent_message' || payloadType === 'user_message') {
    t.uuid = `codex:${sha256Short(raw)}`
    // `message` shape: {role: 'user'|'assistant'|'developer', content: [{type: 'input_text'|'output_text', text}]}
    // `agent_message` / `user_message` shape: {message: string, phase?, ...}
    if (payloadType === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : undefined
      t.role = role
      const content = payload.content
      if (Array.isArray(content)) {
        const parts: string[] = []
        for (const c of content) {
          if (!c || typeof c !== 'object') continue
          const cAny = c as Record<string, unknown>
          if (typeof cAny.text === 'string') parts.push(cAny.text)
        }
        t.textContent = parts.join('\n')
      }
    } else {
      t.role = payloadType === 'agent_message' ? 'assistant' : 'user'
      if (typeof payload.message === 'string') t.textContent = payload.message
    }
    return t
  }

  // Fell through: known ingest set contains this type but no handler.
  // Shouldn't happen; if a new kind lands in CODEX_INGEST_TYPES with no
  // branch here it'd end up here with null uuid and drop. Better to log
  // via drift advisory by returning a stub with the type but no uuid.
  t.uuid = null
  return t
}

function subtypeForCodex(t: ParsedTurn): string {
  switch (t.type) {
    case 'message':
      return t.role === 'assistant' ? 'assistant_message' : 'user_message'
    case 'user_message':
      return 'user_message'
    case 'agent_message':
      return 'assistant_message'
    case 'function_call':
    case 'custom_tool_call':
    case 'web_search_call':
      return 'tool_call'
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'web_search_end':
    case 'patch_apply_end':
    case 'exec_command_end':
      return 'tool_result'
    case 'reasoning':
      return 'thinking'
    case 'context_compacted':
      return 'compact_summary'
    default:
      return t.type
  }
}

export const codexAdapter: TailerAdapter = {
  agentKind: 'codex',
  transcriptGlob: '~/.codex/sessions/**/rollout-*.jsonl',
  perMessageDir: false,
  knownIngestTypes: CODEX_INGEST_TYPES,
  knownIgnoredTypes: CODEX_IGNORED_TYPES,
  resolveCwd(sourcePath: string): string | null {
    return readCodexCwd(sourcePath)
  },
  parseUnit(rawContent: string, _sourcePath?: string): ParsedTurn | ParsedTurn[] | null {
    return parseCodexLine(rawContent)
  },
  pickCommandForCache(_toolName, input) {
    // Codex `shell_command` puts the command at `input.command`; the
    // default picker already covers that. Explicit override for clarity
    // and to guard against Codex tools naming things differently in
    // future.
    for (const k of ['command', 'workdir', 'file_path', 'path', 'url', 'query']) {
      const v = input[k]
      if (typeof v === 'string' && v) return v
    }
    return null
  },
  subtypeFor: subtypeForCodex
}

/** Test-only: overridable transcript root. Mutates the adapter's glob
 *  so tests can point at a scratch dir. */
export function overrideCodexTranscriptRoot(root: string): void {
  ;(codexAdapter as { transcriptGlob: string }).transcriptGlob =
    path.join(root, '**', 'rollout-*.jsonl')
}
