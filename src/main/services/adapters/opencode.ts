// OpenCode transcript adapter for the tailer host (v0.8.1 B).
//
// OpenCode's on-disk layout is unlike Claude and Codex — a message is
// SPLIT across two directory hierarchies:
//   ~/.local/share/opencode/storage/message/ses_<sid>/msg_<mid>.json
//     → stub with role/model/agent/parentID metadata, NO content.
//   ~/.local/share/opencode/storage/part/msg_<mid>/prt_<pid>.json
//     → the actual content, one part per file. Part types observed:
//       text | tool | reasoning | step-start | step-finish
//   ~/.local/share/opencode/storage/session/<projectHash>/ses_<sid>.json
//     → session metadata with `directory` (the cwd) + title + timings.
//
// We use the host's per-message-directory layout mode:
//   perMessageDir: true, transcriptGlob points at storage/message/.
//   Session dirs (ses_<sid>) are direct children of the watched root.
//   Each msg_<mid>.json file inside a session dir is one "unit".
//
// `parseUnit(raw, sourcePath)` reads the msg stub for metadata, then
// walks the sibling `storage/part/msg_<mid>/` directory to assemble the
// content. Returns an ARRAY: the message turn plus one tool_call +
// tool_result pair per `tool` part (giving RedLog its usual granular
// event stream). All array elements share a parentUuid pointing at the
// message stub's messageID, so the chain within one message stays
// intact even though the parts arrive as separate audit events.
//
// KNOWN LIMITATION (v0.8.1): parts that land AFTER the msg stub is
// first observed are not re-scanned. Dedup keys off filename in the
// sidecar index, so a re-emit would fire on the next msg stub arrival
// but by then the parts are frozen. For post-hoc audit review this is
// fine — the on-disk parts remain complete; only live-tail is partial.
// v0.8.2+ will add a secondary chokidar watch on `storage/part/` to
// close this gap.

import * as fs from 'fs'
import * as path from 'path'
import type { TailerAdapter, ParsedTurn } from '../tailer-host'

// Part types we care about. `step-start` / `step-finish` are boundary
// markers OpenCode uses internally — they carry snapshot ids and token
// stats but no user-visible content, so we skip them.
const PART_INGEST_TYPES = new Set(['text', 'tool', 'reasoning'])

// Ingest types the host sees. We flatten OpenCode's message + parts
// into two conceptual kinds: `message` (user/assistant chat + reasoning)
// and `tool_call` / `tool_result` (from tool parts). All emit via
// subtypeFor below.
export const OPENCODE_INGEST_TYPES = new Set([
  'user_message',
  'assistant_message',
  'thinking',
  'tool_call',
  'tool_result'
])

// No ignored types at this level — filtering happens inside the parts
// walk (step-start / step-finish never surface as ParsedTurns).
export const OPENCODE_IGNORED_TYPES = new Set<string>()

/** Locate the OpenCode session metadata file for a given session id. */
function findSessionMetaPath(storageRoot: string, sessionId: string): string | null {
  const sessionRoot = path.join(storageRoot, 'session')
  let projectHashes: string[]
  try { projectHashes = fs.readdirSync(sessionRoot) } catch { return null }
  for (const h of projectHashes) {
    const candidate = path.join(sessionRoot, h, `${sessionId}.json`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Given a sessionDir like `<storage>/message/ses_<sid>`, walk up to
 *  storage root and read the session's `directory` field. */
export function readOpenCodeCwd(sessionDir: string): string | null {
  const messageRoot = path.dirname(sessionDir)          // <storage>/message
  const storageRoot = path.dirname(messageRoot)         // <storage>
  const sessionId = path.basename(sessionDir)
  const metaPath = findSessionMetaPath(storageRoot, sessionId)
  if (!metaPath) return null
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const obj = JSON.parse(raw) as { directory?: unknown }
    if (typeof obj.directory === 'string' && obj.directory) return obj.directory
  } catch { /* ignore */ }
  return null
}

interface OpencodeMsgStub {
  id: string
  sessionID: string
  role: 'user' | 'assistant' | string
  agent?: string
  model?: { providerID?: string; modelID?: string } | string
  parentID?: string | null
  path?: unknown
  time?: { created?: number }
}

interface OpencodePart {
  id: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
  }
}

/** Parse an OpenCode message stub JSON + its sibling parts dir into a
 *  flat array of ParsedTurns (message + tool_call/tool_result pairs). */
export function parseOpencodeMessage(rawStub: string, msgFilePath: string): ParsedTurn[] {
  let stub: OpencodeMsgStub
  try { stub = JSON.parse(rawStub) as OpencodeMsgStub } catch { return [] }
  if (!stub.id) return []

  // Derive the parts dir: <storage>/part/msg_<id>/
  const sessionDir = path.dirname(msgFilePath)          // <storage>/message/ses_<sid>
  const messageRoot = path.dirname(sessionDir)          // <storage>/message
  const storageRoot = path.dirname(messageRoot)         // <storage>
  const partsDir = path.join(storageRoot, 'part', stub.id)

  const partFiles: string[] = (() => {
    try { return fs.readdirSync(partsDir).filter((n) => n.endsWith('.json')).sort() }
    catch { return [] }
  })()

  const parts: OpencodePart[] = []
  for (const name of partFiles) {
    try {
      const raw = fs.readFileSync(path.join(partsDir, name), 'utf-8')
      const obj = JSON.parse(raw) as OpencodePart
      if (obj && typeof obj.type === 'string' && PART_INGEST_TYPES.has(obj.type)) {
        parts.push(obj)
      }
    } catch { /* skip bad part */ }
  }

  // Assemble the message-level turn.
  const modelId = typeof stub.model === 'string'
    ? stub.model
    : (stub.model?.modelID ?? undefined)

  const textParts = parts.filter((p) => p.type === 'text' && typeof p.text === 'string')
  const reasoningParts = parts.filter((p) => p.type === 'reasoning' && typeof p.text === 'string')
  const toolParts = parts.filter((p) => p.type === 'tool')

  const msgTurn: ParsedTurn = {
    uuid: `opencode:msg:${stub.id}`,
    parentUuid: stub.parentID ? `opencode:msg:${stub.parentID}` : null,
    // Adapter-internal type — see subtypeForOpencode.
    type: stub.role === 'assistant' ? 'assistant_message' : 'user_message',
    role: stub.role,
    model: modelId,
    textContent: textParts.map((p) => p.text ?? '').join('\n') || undefined,
    hasThinking: reasoningParts.length > 0 ? true : undefined
  }

  const turns: ParsedTurn[] = [msgTurn]

  // Reasoning parts as separate `thinking` events when they carry text
  // (unlike Codex reasoning which is encrypted). Preserves granularity
  // for operators who want to inspect the model's chain of thought.
  for (const rp of reasoningParts) {
    turns.push({
      uuid: `opencode:reason:${rp.id}`,
      parentUuid: `opencode:msg:${stub.id}`,
      type: 'thinking',
      textContent: rp.text
    })
  }

  // Tool parts fan out into tool_call + tool_result. OpenCode stores
  // both sides in a single part with `state.status`, `state.input`,
  // `state.output`. When status='pending' or 'running' there's no
  // output yet; we still emit the tool_call so the timeline shows the
  // request.
  for (const tp of toolParts) {
    const callId = typeof tp.callID === 'string' ? tp.callID : tp.id
    const toolName = typeof tp.tool === 'string' ? tp.tool : undefined
    const input = (tp.state?.input && typeof tp.state.input === 'object')
      ? (tp.state.input as Record<string, unknown>)
      : undefined
    turns.push({
      uuid: `opencode:tc:${callId}`,
      parentUuid: `opencode:msg:${stub.id}`,
      type: 'tool_call',
      toolName,
      toolUseId: callId,
      toolInput: input
    })
    const status = tp.state?.status
    if (status === 'completed' || status === 'error' || tp.state?.output !== undefined) {
      const outputRaw = tp.state?.output
      const output = typeof outputRaw === 'string'
        ? outputRaw
        : (outputRaw !== undefined ? safeStringify(outputRaw) : undefined)
      turns.push({
        uuid: `opencode:tr:${callId}`,
        parentUuid: `opencode:tc:${callId}`,
        type: 'tool_result',
        toolUseId: callId,
        toolOutput: output
      })
    }
  }

  return turns
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return '' }
}

function subtypeForOpencode(t: ParsedTurn): string {
  // The adapter maps directly — its internal types ARE the emit
  // subtypes, so this is a passthrough.
  return t.type
}

export const opencodeAdapter: TailerAdapter = {
  agentKind: 'opencode',
  transcriptGlob: '~/.local/share/opencode/storage/message/*',
  perMessageDir: true,
  knownIngestTypes: OPENCODE_INGEST_TYPES,
  knownIgnoredTypes: OPENCODE_IGNORED_TYPES,
  resolveCwd(sourcePath: string): string | null {
    return readOpenCodeCwd(sourcePath)
  },
  parseUnit(rawContent: string, sourcePath?: string): ParsedTurn | ParsedTurn[] | null {
    if (!sourcePath) return null
    const arr = parseOpencodeMessage(rawContent, sourcePath)
    return arr.length ? arr : null
  },
  subtypeFor: subtypeForOpencode
}

/** Test-only override for the transcript root. */
export function overrideOpencodeStorageRoot(storageRoot: string): void {
  ;(opencodeAdapter as { transcriptGlob: string }).transcriptGlob =
    path.join(storageRoot, 'message', '*')
}
