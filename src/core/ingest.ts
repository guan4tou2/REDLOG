// Ingest — the one path every event takes into the record.
//
// Before this module the processing pipeline (causal links, target extraction,
// technique detection, loot scanning, redaction spans, scope dispatch, the
// companion events) lived inside the `POST /api/events` HTTP handler. An
// external producer got all of it; the nineteen in-process producers that
// called `insertEvent` directly got none of it and each remembered — or forgot
// — to `eventBus.publish` afterwards. The same shell command therefore meant
// different things depending on which door it came through.
//
// `ingest()` is that door. Both the REST route and the in-process producers
// call it. It owns the order (docs/DESIGN-plugin-kernel.md §3):
//
//   pause gate → causes → enrich (stamps) → redaction spans → insertEvent
//   (raw stored, envelope hashed) → publish → alert dispatch → companions
//
// `insertEvent` stays the DB write; ingest is the policy around it.

import { insertEvent, PAUSE_EXEMPT_AGENT_TYPES, type RedLogEvent, type EnvelopeInput } from './db/events'
import { eventBus } from './event-bus'
import { resolveIncomingCauses, noteStartEvent } from './causes-resolver'
import { socketCausesFor, noteCommandPid } from './socket-attribution'
import { scopeSignalFor } from './alert/scope-signal'
import { detectCredentialUse } from './credential-detector'
import { extractTargetWithProvenance } from './target-extractor'
import { detectPivot } from './pivot-detector'
import { detectCleanup, detectFileTransfer } from './technique-tagger'
import { tagCommand } from './command-tagger'
import { redact, getRules } from './redaction'
import { extractBodyToSidecar } from './http-body-store'

// ── Injected collaborators ──────────────────────────────────────────────────
// core/ cannot import main/, so the pieces that live there are handed in.

export interface LootDetectorLike {
  findMatches?: (text: string) => Array<{ type: string; value: string; line: string; confidence: 'high' | 'medium' | 'low' }>
  scan: (text: string, targetId?: string, source?: string, causeEventId?: string) => Array<{ type: string; value: string; confidence: 'high' | 'medium' | 'low' }>
  emit?: (matches: Array<{ type: string; value: string; line: string; confidence: 'high' | 'medium' | 'low' }>, opts: { targetId?: string; source?: string; causeEventId?: string }) => void
}

export interface AlertRuntimeLike {
  dispatchTargetHit: (input: { target: string; source: 'shell' | 'dns' | 'http' | 'scanner' | 'agent_tool'; action: string; sourceEventId?: string | null }) => void
}

/** Live byte position of a built-in terminal's .cast, for bracketing a
 *  command's output. main/terminal-manager owns the pty, so it is injected. */
export type CastProbe = (terminalId: string) => { castPath: string; offset: number; truncated: boolean } | null

let lootDetectorRef: LootDetectorLike | null = null
let alertRuntimeRef: AlertRuntimeLike | null = null
let castProbe: CastProbe | null = null

export function configureIngest(opts: { lootDetector?: LootDetectorLike | null; alertRuntime?: AlertRuntimeLike | null; castProbe?: CastProbe | null }): void {
  if (opts.lootDetector !== undefined) lootDetectorRef = opts.lootDetector
  if (opts.alertRuntime !== undefined) alertRuntimeRef = opts.alertRuntime
  if (opts.castProbe !== undefined) castProbe = opts.castProbe
}

// command_start byte offset per terminal, so command_end can bracket the
// output it produced inside the .cast (v0.9.6 T2).
const castOffsetAtStart = new Map<string, number>()

// ── Input / result ──────────────────────────────────────────────────────────

export interface IngestInput {
  agentType: string
  data: Record<string, unknown>
  operatorId: string
  engagementId: string
  targetId?: string
  bypassPause?: boolean
  /** Envelope: raw bytes / ref, mapper, producer id, producer timestamp. */
  envelope?: EnvelopeInput
  /** A companion emitted by the pipeline itself. Skips enrichment so a
   *  derived row cannot derive further rows (no pivot-of-a-pivot). */
  derived?: boolean
}

export interface IngestResult {
  /** The row that landed, or null when nothing was written. */
  event: RedLogEvent | null
  /** Why nothing was written. `paused` = recording is paused and this type is
   *  not exempt; `dedup` = insertEvent's 2 s duplicate window. */
  skipped?: 'paused' | 'dedup'
  /** Companion rows written because of this one (pivot, cleanup, loot…). */
  companions: RedLogEvent[]
}

// ── The pipeline ────────────────────────────────────────────────────────────

export function ingest(input: IngestInput): IngestResult {
  const { agentType, engagementId, operatorId } = input
  const data = input.data
  let targetId = input.targetId

  // 1. Pause gate. Nothing below may run while paused: the derivations emit
  //    their own rows and would leak the very content the operator paused to
  //    keep out — a scope_violation names the target of a command that was
  //    never recorded. insertEvent has the same gate; this one is earlier.
  if (!PAUSE_EXEMPT_AGENT_TYPES.has(agentType) && !input.bypassPause && eventBus.paused) {
    return { event: null, skipped: 'paused', companions: [] }
  }

  // 2. Causal links from fields the producer already sent (flow_id,
  //    terminal_id + pid).
  const causeIds = [...resolveIncomingCauses(agentType, data), ...socketCausesFor(agentType, data)]
  if (causeIds.length > 0) {
    const existing = Array.isArray(data._causes) ? (data._causes as string[]) : []
    data._causes = [...new Set([...existing, ...causeIds])]
  }

  // 3. Enrichment stamps + what the companions will need. Only for primary
  //    rows: a companion is already the product of enrichment.
  const plan = input.derived ? emptyPlan() : enrich(agentType, data, targetId)
  if (plan.targetId && !targetId) targetId = plan.targetId

  // 4. Redaction spans (docs/redaction-design.md layer 2). Detect only; the
  //    bytes stay so the chain closes over the true text. UI masks, export
  //    sanitises.
  detectRedactions(data, plan.lootValues)

  // 5. Write. insertEvent stores the raw bytes and hashes the envelope.
  const event = insertEvent(agentType, data, {
    engagementId, operatorId, targetId, bypassPause: input.bypassPause, envelope: input.envelope
  })
  if (!event) return { event: null, skipped: 'dedup', companions: [] }

  // 6. Publish — once, here, for every producer.
  eventBus.publish(event, { bypassPause: input.bypassPause })
  noteStartEvent(agentType, data, event.id)
  // Record pid → this command_start so later traffic on that pid's sockets can
  // cite it (docs/DESIGN-traffic-attribution.md §2.3).
  if (agentType === 'shell' && data.subtype === 'command_start') {
    noteCommandPid(data.pid as number | undefined, event.id)
  }

  // 7. Scope dispatch, after the insert so the violation cites this row.
  if (alertRuntimeRef) {
    const hit = scopeSignalFor(agentType, data)
    if (hit) alertRuntimeRef.dispatchTargetHit({ ...hit, sourceEventId: event.id })
  }

  // 8. Companions. Each goes back through ingest as `derived`, so it gets a
  //    raw ref and an envelope like any row, and never enriches further.
  const companions: RedLogEvent[] = []
  const emitCompanion = (type: string, d: Record<string, unknown>, tid?: string): void => {
    try {
      const r = ingest({
        agentType: type, data: { ...d, _causes: [event.id] }, operatorId, engagementId,
        targetId: tid ?? targetId, derived: true,
        envelope: { source: input.envelope?.source, mapper: { id: 'derived', version: '1' } }
      })
      if (r.event) companions.push(r.event)
    } catch { /* companions are additive; the primary row already landed */ }
  }

  if (plan.pendingLootMatches.length > 0 && lootDetectorRef?.emit) {
    lootDetectorRef.emit(plan.pendingLootMatches, { targetId, source: data.command as string, causeEventId: event.id })
  }
  if (plan.pivot) {
    const p = plan.pivot
    emitCompanion('pivot', {
      subtype: p.subtype, tool: p.tool, via: p.via, route: p.route,
      socks_port: p.socksPort, forward: p.forward, mitre_ttp: p.mitreTtp,
      command: data.command,
      description: `Pivot via ${p.tool}${p.via ? ` → ${p.via}` : ''}${p.route ? ` (${p.route})` : ''}`
    }, p.via ?? targetId)
  }
  if (plan.cleanup) {
    const c = plan.cleanup
    emitCompanion('cleanup', {
      subtype: c.subtype, tool: c.tool, target: c.target, mitre_ttp: c.mitreTtp, command: data.command,
      description: `Cleanup [${c.tool}] ${c.subtype}${c.target ? ` → ${c.target}` : ''}`
    })
  }
  if (plan.fileXfer) {
    const f = plan.fileXfer
    emitCompanion('file_transfer', {
      subtype: f.direction, tool: f.tool, url: f.url, localPath: f.localPath, remotePath: f.remotePath,
      mitre_ttp: f.mitreTtp, command: data.command,
      description: `${f.direction === 'download' ? '↓' : '↑'} ${f.tool}: ${f.url || f.remotePath || f.localPath || ''}`.trim()
    })
  }
  if (plan.pivotClose) {
    const p = plan.pivotClose
    emitCompanion('pivot', {
      subtype: 'closed', tool: p.tool, via: p.via, route: p.route, forward: p.forward,
      command: data.command, exit_code: data.exit_code, duration_sec: data.duration_sec,
      description: `Pivot closed [${p.tool}]${p.via ? ` → ${p.via}` : ''}`
    }, p.via ?? targetId)
  }
  if (plan.httpCred) {
    const c = plan.httpCred
    emitCompanion('credential_use', {
      subtype: c.method, url: data.url, host: data.host,
      description: `${c.detail} → ${c.target}`, mitre_ttp: 'T1078'
    }, c.target || targetId)
  }
  for (const cred of plan.commandCreds) {
    emitCompanion('credential_use', {
      subtype: cred.kind, masked: cred.masked,
      ...(cred.destHost ? { host: cred.destHost } : {}),
      ...(cred.userContext ? { user_context: cred.userContext } : {}),
      ...(cred.scheme ? { scheme: cred.scheme } : {}),
      description: `credential in command (${cred.kind})`, mitre_ttp: 'T1078'
    }, cred.destHost || targetId)
  }

  return { event, companions }
}

// ── Enrichment ──────────────────────────────────────────────────────────────

interface Plan {
  targetId?: string
  lootValues: string[]
  pendingLootMatches: Array<{ type: string; value: string; line: string; confidence: 'high' | 'medium' | 'low' }>
  pivot: ReturnType<typeof detectPivot>
  pivotClose: ReturnType<typeof detectPivot>
  cleanup: ReturnType<typeof detectCleanup>
  fileXfer: ReturnType<typeof detectFileTransfer>
  httpCred: { method: string; target: string; detail: string } | null
  commandCreds: ReturnType<typeof detectCredentialUse>
}

function emptyPlan(): Plan {
  return { lootValues: [], pendingLootMatches: [], pivot: null, pivotClose: null, cleanup: null, fileXfer: null, httpCred: null, commandCreds: [] }
}

/** Everything that reads the producer's fields and decides what else this
 *  row implies. Mutates `data` only to add stamps (tags, detectedTarget, io). */
function enrich(agentType: string, data: Record<string, unknown>, targetId: string | undefined): Plan {
  const plan = emptyPlan()

  if (agentType === 'shell' && data.command) {
    const cmd = data.command as string
    const isStart = data.subtype === 'command_start'
    // A command_end for a foreground pivot (ssh -D until Ctrl-C) is the
    // closest signal that the tunnel shut. The duration guard skips
    // backgrounded `-fN` / `&` variants that exit at once while the tunnel
    // keeps running.
    const isEnd = data.subtype === 'command_end' && Number(data.duration_sec ?? 0) >= 2
    if (isEnd) plan.pivotClose = detectPivot(cmd)

    // Bracket this command's output by byte range in the session .cast. The
    // bytes stay on disk; only the reference enters the chain.
    const termId = typeof data.terminalId === 'string' ? data.terminalId : null
    if (termId && data.source === 'builtin-terminal' && castProbe) {
      const pos = castProbe(termId)
      if (pos) {
        if (isStart) {
          castOffsetAtStart.set(termId, pos.offset)
        } else if (data.subtype === 'command_end') {
          const from = castOffsetAtStart.get(termId)
          castOffsetAtStart.delete(termId)
          data.io = from === undefined
            ? { stream: 'cast', ref: pos.castPath, unbracketed: true, truncated: pos.truncated }
            : { stream: 'cast', ref: pos.castPath, off: from, len: Math.max(0, pos.offset - from), truncated: pos.truncated }
        }
      }
    }

    if (isStart) {
      for (const [k, v] of Object.entries(tagCommand(cmd))) if (data[k] === undefined) data[k] = v
      plan.cleanup = detectCleanup(cmd)
      plan.fileXfer = detectFileTransfer(cmd)
      plan.pivot = detectPivot(cmd)
    }

    const detected = extractTargetWithProvenance(cmd)
    if (detected.host) {
      data.detectedTarget = detected.host
      if (detected.pluginId) {
        data.extractor_plugin_id = detected.pluginId
        data.extractor_name = detected.extractorName
      }
      if (!targetId) plan.targetId = detected.host
    }

    if (!isStart && lootDetectorRef) {
      const textToScan = [cmd, data.stdout, data.stderr, data.output]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n')
      if (textToScan) {
        if (lootDetectorRef.findMatches) {
          plan.pendingLootMatches = lootDetectorRef.findMatches(textToScan)
          plan.lootValues = plan.pendingLootMatches.map((m) => m.value).filter((v) => v && v.length >= 6)
        } else {
          const matches = lootDetectorRef.scan(textToScan, targetId ?? plan.targetId, cmd)
          plan.lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6)
        }
      }
    }
  }

  if ((agentType === 'shell' || agentType === 'terminal') && typeof data.command === 'string' && data.command) {
    plan.commandCreds = detectCredentialUse(data.command)
  }

  if (agentType === 'scanner') {
    extractBodyToSidecar(data, 'request_body')
    extractBodyToSidecar(data, 'response_body')
    extractBodyToSidecar(data, 'ws_body')
    extractBodyToSidecar(data, 'tcp_body')
    if (data.subtype === 'http_request_start') plan.httpCred = detectHttpCredential(data)
  }

  return plan
}

function detectHttpCredential(data: Record<string, unknown>): Plan['httpCred'] {
  const host = String(data.host ?? '')
  const reqHeaders = data.request_headers as string[][] | Record<string, string> | undefined
  const headerList: [string, string][] = Array.isArray(reqHeaders)
    ? reqHeaders as [string, string][]
    : reqHeaders ? Object.entries(reqHeaders) : []
  let found: Plan['httpCred'] = null
  for (const [name, value] of headerList) {
    const ln = name.toLowerCase()
    if (ln === 'authorization') {
      const scheme = (value as string).split(' ')[0]?.toLowerCase() ?? ''
      if (scheme === 'basic') found = { method: 'basic_auth', target: host, detail: 'Basic auth header' }
      else if (scheme === 'bearer') found = { method: 'bearer_token', target: host, detail: 'Bearer token' }
      else if (scheme === 'ntlm') found = { method: 'ntlm', target: host, detail: 'NTLM auth' }
      else if (scheme === 'negotiate') found = { method: 'negotiate', target: host, detail: 'Kerberos/Negotiate' }
      else found = { method: scheme || 'auth_header', target: host, detail: `Authorization: ${scheme}` }
      break
    }
    if (ln === 'cookie' && /(?:session|token|auth|jwt|sid)[\s]*=/i.test(value as string)) {
      found = { method: 'session_cookie', target: host, detail: 'Session cookie' }
    }
    if (ln === 'x-api-key' || ln === 'api-key') {
      found = { method: 'api_key', target: host, detail: `${name} header` }
    }
  }
  if (!found) {
    const bodyPreview = typeof data.request_body_preview === 'string' ? data.request_body_preview : ''
    if (bodyPreview && /password|passwd|pass_?word|pwd|credential/i.test(bodyPreview)) {
      found = { method: 'form_login', target: host, detail: 'Password in request body' }
    }
  }
  return found
}

const REDACTED_FIELDS = ['output', 'output_preview', 'command', 'stdout', 'stderr', 'request_body_preview', 'response_preview', 'ws_preview', 'tcp_preview'] as const

function detectRedactions(data: Record<string, unknown>, lootValues: string[]): void {
  const baseRules = getRules()
  const rules = lootValues.length > 0 ? { ...baseRules, denylist: [...baseRules.denylist, ...lootValues] } : baseRules
  for (const field of REDACTED_FIELDS) {
    const v = data[field]
    if (typeof v === 'string' && v) {
      const result = redact(v, rules)
      if (result.redacted.length > 0) {
        const redactions = (data.redactions as unknown[] | undefined) ?? []
        data.redactions = [...redactions, ...result.redacted.map((r) => ({ ...r, field }))]
      }
    }
  }
}

/** Test helper. */
export function _resetIngest(): void {
  castOffsetAtStart.clear()
  lootDetectorRef = null
  alertRuntimeRef = null
  castProbe = null
}
