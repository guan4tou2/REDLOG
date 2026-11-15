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
// call it. It owns the order (docs/design/DESIGN-plugin-kernel.md §3):
//
//   pause gate → causes → enrich (stamps) → redaction spans → insertEvent
//   (raw stored, envelope hashed) → publish → alert dispatch → companions
//
// `insertEvent` stays the DB write; ingest is the policy around it.

import { insertEvent, lastRecordingResumeTime, PAUSE_EXEMPT_AGENT_TYPES, type RedLogEvent, type EnvelopeInput } from './db/events'
import { dbEngagement, dbGeneration } from './db/index'
import { eventBus } from './event-bus'
import { isCapturePlumbing } from './capture-plumbing'
import { commandIdOf, relatedCommandCandidates, resolveIncomingCauses, noteStartEvent, resetCausesResolver, type StoredLinks } from './causes-resolver'
import { storedCommand, storedHighestSeq, storedLastFinal, storedOpenFlowStart, storedSeqSeen, type StoredCommand } from './db/stored-links'
import { socketCausesFor, noteCommandPid } from './socket-attribution'
import { scopeSignalFor } from './alert/scope-signal'
import { detectCredentialUse } from './credential-detector'
import { extractTargetWithProvenance } from './target-extractor'
import { detectPivot } from './pivot-detector'
import { detectCleanup, detectFileTransfer } from './technique-tagger'
import { tagCommand } from './command-tagger'
import { redact, getRules } from './redaction'
import { extractBodyToSidecar, extractTextToSidecar } from './http-body-store'
import { linkHttpBodyEvent } from './http-body-index'
import { noteDbError, notePipelineWarning } from './capture-health'
import { DERIVED, currentEntrance, stripReserved, withEntrance, type IngestEntrance, type TargetVia } from './ingest/stamp'
import { terminalIdentity } from './ingest/terminal'
import { fieldNumber, fieldText } from './ingest/field-text'

// ── Injected collaborators ──────────────────────────────────────────────────
// core/ cannot import main/, so the pieces that live there are handed in.

/** One match as the detector reports it (see loot-detector.ts). */
export interface LootMatchLike {
  ruleId: string
  type: string
  value: string
  line: string
  confidence: 'high' | 'medium' | 'low'
}

export interface LootDetectorLike {
  findMatches?: (text: string) => LootMatchLike[]
  scan: (text: string, targetId?: string, source?: string, causeEventId?: string) => LootMatchLike[]
  emit?: (matches: LootMatchLike[], opts: { targetId?: string; targetVia?: TargetVia; source?: string; causeEventId?: string }) => boolean
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
export interface TerminalLifecycle {
  prepare: (data: Record<string, unknown>, engagementId: string) => boolean
  recorded: (event: RedLogEvent) => void
}
let terminalLifecycle: TerminalLifecycle | null = null

export function configureIngest(opts: { lootDetector?: LootDetectorLike | null; alertRuntime?: AlertRuntimeLike | null; castProbe?: CastProbe | null; terminalLifecycle?: TerminalLifecycle | null }): void {
  if (opts.lootDetector !== undefined) lootDetectorRef = opts.lootDetector
  if (opts.alertRuntime !== undefined) alertRuntimeRef = opts.alertRuntime
  if (opts.castProbe !== undefined) castProbe = opts.castProbe
  if (opts.terminalLifecycle !== undefined) terminalLifecycle = opts.terminalLifecycle
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
  /** `operator-selected`: `targetId` is the operator's currently selected
   *  target, passed by an in-app action (Spec 071 `_ingest.target_via`). Taken
   *  from the in-process door only; any other door's target is `explicit`.
   *  A derived row's writer passes the via its target came with. */
  targetVia?: TargetVia
  bypassPause?: boolean
  /** Envelope: raw bytes / ref, producer timestamp. */
  envelope?: EnvelopeInput
  /** When the reported thing actually happened at the source, if the producer
   *  knows and it is not simply "now" — a replayed transcript, a spool that sat
   *  offline. Lands in `timestamp`; `created_at` stays RedLog's receipt clock.
   *  Producers that already carry it in `data.source_timestamp` or
   *  `envelope.tsSource` need not repeat it here. See resolveOccurredAt in
   *  db/event-write.ts for the precedence and the validation. */
  occurredAt?: number
  /** A companion emitted by the pipeline itself. Skips enrichment so a
   *  derived row cannot derive further rows (no pivot-of-a-pivot). Stamped
   *  with the `derived` producer, whatever `entrance` says. */
  derived?: boolean
  /** Which door received the row, as that door authenticated it (Spec 071
   *  FR-005). Absent: the caller's (withEntrance), else in-process. */
  entrance?: IngestEntrance
  /** Set by the spool drain only: the file was judged against the project's
   *  recorded pause intervals before it got here (Spec 071 FR-082 as revised
   *  2026-11-13). The pause in effect now still refuses it. */
  spoolJudged?: boolean
}

/** `_ingest.target_via` of a row that landed. */
function storedTargetVia(event: RedLogEvent): TargetVia {
  const stamp = event.data._ingest as { target_via?: TargetVia } | undefined
  return stamp?.target_via ?? 'none'
}

/** The row an error was thrown after: ingest committed it, then a step after
 *  the commit (publish, scope dispatch, companions, bookkeeping) threw. A
 *  caller that retries on a throw must not retry this one — the row is there.
 *  Null for an error thrown before anything was written. */
export function committedEventOf(error: unknown): RedLogEvent | null {
  return (error as { committedEvent?: RedLogEvent } | null)?.committedEvent ?? null
}

export interface IngestResult {
  /** The row that landed, or null when nothing was written. */
  event: RedLogEvent | null
  /** Why nothing was written. `paused` = recording is paused and this type is
   *  not exempt; `dedup` = insertEvent's 2 s duplicate window; `plumbing` =
   *  RedLog's own shell wiring, which never becomes evidence. */
  skipped?: 'paused' | 'dedup' | 'plumbing' | 'unrecorded'
  /** Companion rows written because of this one (pivot, cleanup, loot…). */
  companions: RedLogEvent[]
}

/** Migration-friendly canonical entry point for in-process producers. It has
 * the DB primitive's call shape while still executing the complete ingest
 * policy. New code should prefer `ingest()` when it needs skip/companion data. */
export function ingestEvent(
  agentType: string,
  data: Record<string, unknown>,
  opts: { engagementId: string; operatorId: string; targetId?: string; targetVia?: TargetVia; bypassPause?: boolean; envelope?: EnvelopeInput; occurredAt?: number }
): RedLogEvent | null {
  return ingest({ agentType, data, ...opts }).event
}

// ── The pipeline ────────────────────────────────────────────────────────────

export function ingest(input: IngestInput): IngestResult {
  const { agentType, engagementId, operatorId } = input
  // A copy: the pipeline below takes keys out of `data` and adds to it, and the
  // caller's object is the caller's. Reusing one object for two calls must
  // record the same `stripped` both times.
  const data = { ...input.data }
  let targetId = input.targetId

  // A row for another engagement is work that outlived its project. insertEvent
  // refuses it, but only after enrichment has stored the row's bodies under the
  // OPEN project's directory and settled its command pairs in this project's
  // runtime. Same check, earlier, so a refused row has no side effects.
  // Reported as `dedup`, as it always was; the refusal is named in the log.
  const bound = dbEngagement()
  if (bound !== null && input.engagementId !== undefined && input.engagementId !== bound) {
    console.error(`[ingest] refused a ${agentType} row for engagement ${input.engagementId}: the open database belongs to ${bound}`)
    return { event: null, skipped: 'dedup', companions: [] }
  }
  dropStateOfClosedProject()

  // The stamp's half that must happen first (FR-090: stamp before dedup,
  // policy and derivation): the producer's values for the receiver-owned keys
  // leave `data` before anything reads it. insertEvent writes the stamp.
  const entrance = input.derived ? DERIVED : (input.entrance ?? currentEntrance())
  const stripped = stripReserved(data)

  // The cwd hint settles here even if the evidence write is paused: otherwise
  // a command_end seen during pause leaves a phantom active command that can
  // be correlated with unrelated files after recording resumes. The causal
  // links settle only once the row is stored (`settled`, run after the
  // commit): a refused row was never recorded, so the command it would have
  // closed is still open in the record, as the stored rows say after a restart.
  const stored = storedLinks()
  const settled: Array<() => void> = []
  const lifecycleCauseIds = resolveIncomingCauses(agentType, data, stored, (change) => { settled.push(change) })
  if (agentType === 'shell' && !input.derived && terminalLifecycle && !terminalLifecycle.prepare(data, engagementId)) {
    return { event: null, skipped: 'unrecorded', companions: [] }
  }

  // An asynchronous sender can arrive after the operator resumed. Receipt
  // time cannot authorize bytes observed in the closed interval. Reject the
  // whole mixed batch conservatively, before any sidecar or derivation.
  const outputAt = data.subtype === 'command_end' && data.output_streamed !== true
    ? data.output_started_at : data.source_timestamp
  const subtypeText = fieldText(data.subtype) ?? ''
  const delayedCapture = (agentType === 'shell' && ['command_output', 'session_output', 'command_end'].includes(subtypeText))
    || (agentType === 'scanner' && ['http_response_chunk', 'ws_message', 'tcp_message'].includes(subtypeText))
  // The spool drain has already judged its file against the recorded pause
  // intervals (core/spool-drain.ts); this "older than the last resume" rule
  // is what left a command_end observed before a pause stuck there forever.
  if (delayedCapture && !input.bypassPause && !input.spoolJudged
      && typeof outputAt === 'number' && Number.isFinite(outputAt)
      && outputAt <= Math.max(eventBus.resumedAt, lastRecordingResumeTime())) {
    return { event: null, skipped: 'paused', companions: [] }
  }

  // 1. Pause gate. Nothing below may run while paused: the derivations emit
  //    their own rows and would leak the very content the operator paused to
  //    keep out — a scope_violation names the target of a command that was
  //    never recorded. insertEvent has the same gate; this one is earlier.
  if (!PAUSE_EXEMPT_AGENT_TYPES.has(agentType) && !input.bypassPause && eventBus.paused) {
    return { event: null, skipped: 'paused', companions: [] }
  }

  // 1b. RedLog's own plumbing never enters the record. The shell adapters
  //    report every command their shell runs, including the one that sourced
  //    the adapter — dropping it here rather than at display time is what
  //    keeps it out of the hash chain, and therefore out of the bundle the
  //    client reads (the export must walk every chained row; it cannot skip).
  if (agentType === 'shell' && isCapturePlumbing(data.command)) {
    return { event: null, skipped: 'plumbing', companions: [] }
  }

  // 2. Causal links from fields the producer already sent (flow_id,
  //    terminal_id + pid).
  // 2a. An output chunk that found no open command is kept and labelled, not
  //    dropped and not guessed at. Background output inherits the descriptor
  //    the relay held when it forked, so it lands inside whichever command is
  //    running (research.md O3); a hole in the evidence and a wrong
  //    attribution are both worse than saying which it was. FR-007.
  if (agentType === 'shell' && data.subtype === 'command_output' && lifecycleCauseIds.length === 0) {
    data.unattributed = true
  }

  const causeIds = [...lifecycleCauseIds, ...socketCausesFor(agentType, data)]
  if (causeIds.length > 0) {
    const existing = Array.isArray(data._causes) ? (data._causes as string[]) : []
    data._causes = [...new Set([...existing, ...causeIds])]
  }
  // Filesystem delivery can lag behind the write under load. Correlate with
  // the file's observed modification time when it is usable, while keeping
  // createdAt as the independent RedLog receipt time.
  const observedAt = typeof data.mtime === 'number' && Number.isFinite(data.mtime)
    ? data.mtime
    : Date.now()
  const relatedCommands = relatedCommandCandidates(data, observedAt)
  if (relatedCommands.length > 0) {
    const existing = Array.isArray(data.related_commands) ? data.related_commands : []
    const combined = [...existing, ...relatedCommands]
    data.related_commands = combined.filter((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return true
      const value = candidate as Record<string, unknown>
      return combined.findIndex((other) => {
        if (!other || typeof other !== 'object') return false
        const compared = other as Record<string, unknown>
        return compared.event_id === value.event_id && compared.method === value.method && compared.state === value.state
      }) === index
    })
  }

  // 2a''. What ingest remembers about a command whose background output this
  //     is: the target the command was filed under and the chunks already
  //     stored. When it remembers nothing — the app restarted, or the entry
  //     was evicted — it is read back from the command's rows, as it would have
  //     been remembered (restoreLateState).
  const lateCommandId = agentType === 'shell' && data.subtype === 'command_output' ? commandIdOf(data) : null
  const late = lateCommandId && !input.derived
    ? lateByCommand.get(lateCommandId) ?? restoreLateState(lateCommandId, stored)
    : undefined

  // 2a'. A relay that times out waiting for our answer sends the same chunk
  //     again, and we may already have it: the request landed, the reply was
  //     late. Same command, same seq is the same chunk, so it is kept once --
  //     otherwise the detail pane prints those lines twice and the byte count
  //     on the final row stops matching what is stored.
  if (late && lateCommandId && (data.late === true || data.streamed === true) && typeof data.seq === 'number'
      && (late.seen.has(data.seq)
        || (late.stored !== undefined && data.seq <= late.stored.highest
          && stored.guard(() => storedSeqSeen(lateCommandId, data.seq as number, late.stored!.after), false)))) {
    return { event: null, skipped: 'dedup', companions: [] }
  }

  // 3. Enrichment stamps + what the companions will need. Only for primary
  //    rows: a companion is already the product of enrichment.
  //
  //    How the row got its target (`_ingest.target_via`), first non-empty
  //    wins: the writer's own (explicit, or operator-selected from an in-app
  //    action — in-process only), then a host the extractor read from the
  //    command, then the target a background job's command was filed under.
  //    Nothing else gives a row a target: not the terminal it came from, not
  //    the engagement's selected target.
  let targetVia: TargetVia = 'none'
  if (targetId) {
    const claimed = input.targetVia
    const believed = claimed !== undefined && claimed !== 'none'
      && (input.derived || (claimed === 'operator-selected' && entrance.door === 'in-process'))
    targetVia = believed ? claimed : 'explicit'
  }
  const plan = input.derived ? emptyPlan() : enrich(agentType, data, targetId)
  if (plan.targetId && !targetId) { targetId = plan.targetId; targetVia = 'extracted' }
  // 2b. A background job's late output has no command text to read a target
  //     from, and must not get one by reading its bytes. The command it belongs
  //     to was filed under a target when it ended; the chunk goes to the same.
  //     A command filed under none gives a chunk none.
  if (!targetId && late?.filed && late.target) { targetId = late.target; targetVia = 'command' }

  // 4. Redaction spans (docs/redaction-design.md layer 2). Detect only; the
  //    bytes stay so the chain closes over the true text. UI masks, export
  //    sanitises.
  detectRedactions(data, plan.lootValues)

  // 5. Write. insertEvent stores the raw bytes and hashes the envelope.
  const event = insertEvent(agentType, data, {
    engagementId, operatorId, targetId, targetVia, bypassPause: input.bypassPause, envelope: input.envelope,
    occurredAt: input.occurredAt, entrance, stripped
  })
  if (!event) return { event: null, skipped: 'dedup', companions: [] }
  // Everything after the commit. A throw from here still propagates, but
  // carries the committed row (committedEventOf), so a caller that retries on
  // failure — the spool drain — does not write it a second time.
  try {
    return afterCommit(event)
  } catch (error) {
    const marked = error !== null && typeof error === 'object' ? error : new Error(String(error))
    throw Object.assign(marked, { committedEvent: event })
  }

  function afterCommit(event: RedLogEvent): IngestResult {
  // What the row's target is as STORED: the late-output bookkeeping, the
  // companions and the loot below read it from the row that landed, so what
  // they carry is what a restart finds again (restoreLateState reads the same
  // columns), not a local variable that insertEvent never saw.
  const landed = { target: event.targetId ?? null, via: storedTargetVia(event) }
  // Each step on its own: one that throws is reported and the rest still run,
  // and the row — committed — is still the answer. A caller must never be told
  // a written row failed (it would resend it, or record a gap for it).
  const step = (name: string, run: () => void): void => {
    try { run() } catch (error) {
      console.error(`[ingest] a step after the commit failed (${name}); the row is written:`, error)
      notePipelineWarning('ingest-post-commit', error)
    }
  }
  step('terminal lifecycle', () => {
    if (agentType === 'shell' && !input.derived) terminalLifecycle?.recorded(event)
  })
  step('late-output bookkeeping', () => {
    const commandId = agentType === 'shell' && !input.derived ? commandIdOf(data) : null
    if (!commandId) return
    if (data.subtype === 'command_start') {
      // A new round of this id: its chunks are counted afresh. (A chunk that
      // came before its start is forgotten here, so its resend after the start
      // is stored again; keeping it would take a lookup at every start to
      // agree after a restart. The reader keeps one row per number.)
      remember(commandId, { filed: true, target: landed.target, seen: new Set() })
    } else if (data.subtype === 'command_end' && (data.late_output === true || data.output_streamed === true)) {
      const entry = lateByCommand.get(commandId)
      if (entry) { entry.filed = true; entry.target = landed.target } else remember(commandId, { filed: true, target: landed.target, seen: new Set() })
    } else if (lateCommandId && data.final === true) {
      lateByCommand.delete(commandId)
    } else if (lateCommandId && !late?.transient && (data.late === true || data.streamed === true) && typeof data.seq === 'number') {
      const entry = late ?? lateByCommand.get(commandId)
      if (entry && lateByCommand.get(commandId) === entry) entry.seen.add(data.seq)
      else remember(commandId, { ...(entry ?? { filed: false, target: null }), seen: new Set([...(entry?.seen ?? []), data.seq]) })
    }
  })

  if (agentType === 'scanner') {
    try { linkHttpBodyEvent(event) } catch (error) { noteDbError('http-body-index', error) }
  }

  // 6. Publish — once, here, for every producer.
  step('publish', () => {
    eventBus.publish(event, { bypassPause: input.bypassPause })
  })
  step('causal links', () => {
    for (const change of settled) change()
    noteStartEvent(agentType, data, event.id)
    // Record pid → this command_start so later traffic on that pid's sockets can
    // cite it (docs/design/DESIGN-traffic-attribution.md §2.3).
    if (agentType === 'shell' && data.subtype === 'command_start') {
      noteCommandPid(data.pid as number | undefined, event.id)
    }
  })

  // 7. Scope dispatch, after the insert so the violation cites this row.
  step('scope dispatch', () => {
    if (alertRuntimeRef) {
      const hit = scopeSignalFor(agentType, data)
      // A scope_violation is derived from this row (external-event-policy.ts).
      if (hit) withEntrance(DERIVED, () => alertRuntimeRef!.dispatchTargetHit({ ...hit, sourceEventId: event.id }))
    }
  })

  // 8. Companions. Each goes back through ingest as `derived`, so it gets a
  //    raw ref and an envelope like any row, and never enriches further.
  const companions: RedLogEvent[] = []
  // A companion takes its source row's target and how it got it; a host the
  // detector itself names (`tid`) is explicit.
  const emitCompanion = (type: string, d: Record<string, unknown>, tid?: string): void => {
    try {
      const r = ingest({
        agentType: type, data: { ...d, _causes: [event.id] }, operatorId, engagementId,
        targetId: tid ?? landed.target ?? undefined, targetVia: tid ? 'explicit' : landed.via, derived: true
      })
      if (r.event) companions.push(r.event)
    } catch { /* companions are additive; the primary row already landed */ }
  }

  step('loot', () => {
    if (plan.pendingLootMatches.length > 0 && lootDetectorRef?.emit) {
      // Loot is derived from this row, like the companions below.
      const loot = lootDetectorRef
      withEntrance(DERIVED, () => loot.emit!(plan.pendingLootMatches, { targetId: landed.target ?? undefined, targetVia: landed.via, source: fieldText(data.command), causeEventId: event.id }))
    }
  })
  if (plan.pivot) {
    const p = plan.pivot
    emitCompanion('pivot', {
      subtype: p.subtype, tool: p.tool, via: p.via, route: p.route,
      socks_port: p.socksPort, forward: p.forward, mitre_ttp: p.mitreTtp,
      command: data.command,
      description: `Pivot via ${p.tool}${p.via ? ` → ${p.via}` : ''}${p.route ? ` (${p.route})` : ''}`
    }, p.via)
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
    }, p.via)
  }
  if (plan.httpCred) {
    const c = plan.httpCred
    emitCompanion('credential_use', {
      subtype: c.method, url: data.url, host: data.host,
      description: `${c.detail} → ${c.target}`, mitre_ttp: 'T1078'
    }, c.target)
  }
  for (const cred of plan.commandCreds) {
    emitCompanion('credential_use', {
      subtype: cred.kind, masked: cred.masked,
      ...(cred.destHost ? { host: cred.destHost } : {}),
      ...(cred.userContext ? { user_context: cred.userContext } : {}),
      ...(cred.scheme ? { scheme: cred.scheme } : {}),
      description: `credential in command (${cred.kind})`, mitre_ttp: 'T1078'
    }, cred.destHost)
  }

  return { event, companions }
  }
}

// ── Enrichment ──────────────────────────────────────────────────────────────

interface Plan {
  targetId?: string
  lootValues: string[]
  pendingLootMatches: LootMatchLike[]
  pivot: ReturnType<typeof detectPivot>
  pivotClose: ReturnType<typeof detectPivot>
  cleanup: ReturnType<typeof detectCleanup>
  fileXfer: ReturnType<typeof detectFileTransfer>
  httpCred: { method: string; target: string; detail: string } | null
  commandCreds: ReturnType<typeof detectCredentialUse>
}

/** Last characters of each live PTY session's output, joined to its next
 *  chunk before the loot scan. Long enough for a JWT or a key line; bounded
 *  in count so sessions that never sent `session_end` cannot accumulate. */
const sessionTail = new Map<string, string>()

/** What ingest keeps per command id for a background job's late output: the
 *  target the command was filed under (`filed`: set by its command_start, and
 *  by a command_end that said a job keeps printing), and which chunk numbers
 *  are already stored, so a resend is recognised (live keeps a resent chunk
 *  once, so a restart must too: SC-003). One map, so an entry is evicted
 *  whole: two maps bounded alike but filled by different rows lost one half and
 *  kept the other, and a chunk of a command 256 starts back was filed under
 *  none. Released at the relay's `final` row. */
interface LateCommand {
  filed: boolean
  target: string | null
  seen: Set<number>
  /** Rebuilt from the database: chunks up to number `highest` written after
   *  rowid `after` are stored but not in `seen`, so a resend among them is
   *  asked of the database, one seek. */
  stored?: { after: number; highest: number }
  /** Rebuilt while a lookup failed: used for this row, never kept. */
  transient?: true
}
const lateByCommand = new Map<string, LateCommand>()
const LATE_TARGET_MAX = 256

/** Set `commandId`'s entry, evicting the oldest at the bound. */
function remember(commandId: string, entry: LateCommand): LateCommand {
  if (!lateByCommand.has(commandId) && lateByCommand.size >= LATE_TARGET_MAX) lateByCommand.delete(lateByCommand.keys().next().value as string)
  lateByCommand.set(commandId, entry)
  return entry
}

/** Rebuild `commandId`'s entry from its stored rows, as the bookkeeping would
 *  have left it. The target is the one last filed — the newest command_end of
 *  the round that said a job keeps printing, else the command_start — unless a
 *  final chunk came after it. Chunk numbers count from the newer of the round's
 *  start and the last final chunk, as the bookkeeping forgets them at both.
 *  Three statements. Two are one
 *  index step; the highest-number probe walks down that id's chunk numbers past
 *  any written before the last final chunk or carrying neither flag, so it is
 *  bounded by the id's chunk count, not the table's. Once per restore: the
 *  entry is kept, and the next chunk of this id asks nothing. If a lookup
 *  failed the entry is not kept, so the next chunk asks again. */
function restoreLateState(commandId: string, stored: StoredReads): LateCommand {
  const command = stored.command(commandId)
  const filedBy = command?.lastLateEnd ?? command?.start ?? null
  const finalAt = stored.lastFinal(commandId)
  const filed = filedBy !== null && (finalAt === null || finalAt < filedBy.rowid)
  const after = Math.max(command?.start?.rowid ?? 0, finalAt ?? 0)
  const highest = stored.guard(() => storedHighestSeq(commandId, after), null)
  const entry: LateCommand = {
    filed, target: filed ? filedBy.targetId : null, seen: new Set(),
    ...(highest !== null ? { stored: { after, highest } } : {})
  }
  return stored.failed ? { ...entry, transient: true } : remember(commandId, entry)
}

/** The stored reads, for ingest and the resolver. */
interface StoredReads extends StoredLinks {
  /** `read`, or `none` if it throws: a failed lookup costs the link, never the
   *  row. The failure is noted as a pipeline warning and marks the row
   *  `failed`, so nothing is remembered on it. */
  guard<T>(read: () => T, none: T): T
}

/** The project's rows, read once per ingested row however many steps ask. */
function storedLinks(): StoredReads {
  const commands = new Map<string, StoredCommand | null>()
  const finals = new Map<string, number | null>()
  let failed = false
  const guard = <T>(read: () => T, none: T): T => {
    try { return read() } catch (error) {
      // Once per row: the first failure is the one to see.
      if (!failed) {
        console.error('[ingest] a stored-link lookup failed; the row is written without the link:', error)
        notePipelineWarning('ingest-stored-links', error)
      }
      failed = true
      return none
    }
  }
  return {
    command(commandId) {
      if (!commands.has(commandId)) commands.set(commandId, guard(() => storedCommand(commandId), null))
      return commands.get(commandId) ?? null
    },
    lastFinal(commandId) {
      if (!finals.has(commandId)) finals.set(commandId, guard(() => storedLastFinal(commandId), null))
      return finals.get(commandId) ?? null
    },
    openFlowStart: (flowId) => guard(() => storedOpenFlowStart(flowId), null),
    get failed() { return failed },
    guard
  }
}
const SESSION_TAIL_CHARS = 4096
const SESSION_TAIL_MAX = 64

// The maps above are keyed by terminal id and command id, which a project does
// not own: the next project's first row can carry the same id. When the
// database has been closed since the last row, none of this belongs to the
// project that is open now -- least of all sessionTail, whose bytes are the
// closed project's output, and which would be joined to the new project's first
// chunk and scanned into a loot row there. Keyed to the DB generation rather
// than cleared by the main process, so every way of closing a project is covered.
let seenGeneration = dbGeneration()

function dropStateOfClosedProject(): void {
  const now = dbGeneration()
  if (now === seenGeneration) return
  seenGeneration = now
  clearPerProjectState()
}

function clearPerProjectState(): void {
  castOffsetAtStart.clear()
  sessionTail.clear()
  lateByCommand.clear()
}

function emptyPlan(): Plan {
  return { lootValues: [], pendingLootMatches: [], pivot: null, pivotClose: null, cleanup: null, fileXfer: null, httpCred: null, commandCreds: [] }
}

/** Everything that reads the producer's fields and decides what else this
 *  row implies. Mutates `data` only to add stamps (tags, detectedTarget, io). */
function enrich(agentType: string, data: Record<string, unknown>, targetId: string | undefined): Plan {
  const plan = emptyPlan()

  // A `command` that is not a scalar is not a command (./ingest/field-text.ts).
  const commandText = fieldText(data.command)
  if (agentType === 'shell' && data.command && commandText !== undefined) {
    const cmd = commandText
    const isStart = data.subtype === 'command_start'
    // A command_end for a foreground pivot (ssh -D until Ctrl-C) is the
    // closest signal that the tunnel shut. The duration guard skips
    // backgrounded `-fN` / `&` variants that exit at once while the tunnel
    // keeps running.
    const isEnd = data.subtype === 'command_end' && fieldNumber(data.duration_sec ?? 0) >= 2
    if (isEnd) plan.pivotClose = detectPivot(cmd)

    // Bracket this command's output by byte range in the session .cast. The
    // bytes stay on disk; only the reference enters the chain.
    const termId = terminalIdentity(data)
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
          const loot = lootDetectorRef
          const matches = withEntrance(DERIVED, () => loot.scan(textToScan, targetId ?? plan.targetId, cmd))
          plan.lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6)
        }
      }
    }
  }

  // PTY session output (`redlog-session`) carries stdout but no command, so the
  // block above never saw it: output was stored and searchable, but never
  // scanned (Spec 031). Chunks are arbitrary read boundaries, so each scan
  // includes the tail of the previous chunk of the same session — a secret
  // split across two chunks is found when its second half arrives. Values
  // already recorded are dropped by the detector's dedup, not here.
  const sessionTerminal = agentType === 'shell' ? terminalIdentity(data) : null
  if (sessionTerminal !== null) {
    const tid = sessionTerminal
    if (data.subtype === 'session_output' && typeof data.stdout === 'string' && data.stdout && lootDetectorRef?.findMatches) {
      const text = (sessionTail.get(tid) ?? '') + data.stdout
      sessionTail.delete(tid)
      sessionTail.set(tid, text.slice(-SESSION_TAIL_CHARS))
      if (sessionTail.size > SESSION_TAIL_MAX) sessionTail.delete(sessionTail.keys().next().value as string)
      plan.pendingLootMatches = lootDetectorRef.findMatches(text)
      plan.lootValues = plan.pendingLootMatches.map((m) => m.value).filter((v) => v && v.length >= 6)
    } else if (data.subtype === 'session_start' || data.subtype === 'session_end') {
      sessionTail.delete(tid)
      if (data.source === 'builtin-terminal') castOffsetAtStart.delete(tid)
    }
  }

  // Late output of a background job (`command_output`) is scanned the way PTY
  // session output is: arbitrary line-ish boundaries, so each scan carries the
  // tail of the previous chunk of the same command and stream.
  if (agentType === 'shell' && data.subtype === 'command_output' && typeof data.command_id === 'string') {
    const stream = data.stream === 'stderr' ? 'stderr' : 'stdout'
    const key = `cmd:${data.command_id}:${stream}`
    const body = typeof data[stream] === 'string' ? data[stream] as string : ''
    if (body && lootDetectorRef?.findMatches) {
      const text = (sessionTail.get(key) ?? '') + body
      sessionTail.delete(key)
      sessionTail.set(key, text.slice(-SESSION_TAIL_CHARS))
      if (sessionTail.size > SESSION_TAIL_MAX) sessionTail.delete(sessionTail.keys().next().value as string)
      plan.pendingLootMatches = lootDetectorRef.findMatches(text)
      plan.lootValues = plan.pendingLootMatches.map((m) => m.value).filter((v) => v && v.length >= 6)
    }
    if (data.final === true) {
      sessionTail.delete(`cmd:${data.command_id}:stdout`)
      sessionTail.delete(`cmd:${data.command_id}:stderr`)
    }
  }

  if ((agentType === 'shell' || agentType === 'terminal') && typeof data.command === 'string' && data.command) {
    plan.commandCreds = detectCredentialUse(data.command)
  }

  // Spec 052 T021. Every command is relayed now, so an `nmap -A` body arrives
  // here as a matter of course. Keeping it whole and referencing it is the
  // same answer HTTP bodies already get; a truncation limit would have to be
  // re-argued the first time someone ran a full-port scan (research.md T006).
  //
  // After the loot scan above, which reads `data.stdout` and would find
  // nothing once this has moved it.
  if (agentType === 'shell' && data.subtype === 'command_end') {
    extractTextToSidecar(data, 'stdout', 'stdout_ref')
    extractTextToSidecar(data, 'stderr', 'stderr_ref')
  }

  if (agentType === 'shell' && (data.subtype === 'command_output' || data.subtype === 'session_output')) {
    extractBodyToSidecar(data, 'output_body')
  }

  if (agentType === 'scanner') {
    // It reads headers, `host` and `request_body_preview`, none of which the
    // sidecar move touches, so the order does not change what it finds. It
    // runs first anyway: what can still fail before the insert is better done
    // before a sidecar file exists for a row that may not be written.
    if (data.subtype === 'http_request_start') plan.httpCred = detectHttpCredential(data)
    extractBodyToSidecar(data, 'request_body')
    extractBodyToSidecar(data, 'response_body')
    extractBodyToSidecar(data, 'ws_body')
    extractBodyToSidecar(data, 'tcp_body')
  }

  return plan
}

// The HTTP auth schemes RedLog can name. A `credential_use` row is tagged
// T1078 — MITRE's Valid Accounts — and written to the CHAINED tier, which is
// the layer that reaches the client in `events.jsonl`. That is a statement
// about what the operator did during the engagement, so RedLog makes it only
// about schemes it actually recognises.
//
// #182: it did not. Any token before the first space became a credential_use,
// so Chrome's own device registration — `Authorization: AidLogin …` to
// `android.clients.google.com/c2dm/register3`, which a brand-new profile sends
// on its own, before the operator has navigated anywhere — was delivered to
// the client as "the operator used valid accounts against Google". Three of
// them, in the hash chain, from opening the capture browser.
//
// Nothing is lost by dropping the unknown ones. The request is still recorded
// in full in the logged tier with its headers; what goes is only the claim
// RedLog could not support.
const KNOWN_AUTH_SCHEMES: Record<string, { method: string; detail: string }> = {
  basic: { method: 'basic_auth', detail: 'Basic auth header' },
  bearer: { method: 'bearer_token', detail: 'Bearer token' },
  ntlm: { method: 'ntlm', detail: 'NTLM auth' },
  negotiate: { method: 'negotiate', detail: 'Kerberos/Negotiate' },
  digest: { method: 'digest', detail: 'Digest auth' }
}

function detectHttpCredential(data: Record<string, unknown>): Plan['httpCred'] {
  const host = fieldText(data.host) ?? ''
  const reqHeaders = data.request_headers
  // A header is a pair of scalars; anything else in the list is not one, and
  // is passed over rather than coerced (./ingest/field-text.ts).
  const pairs: unknown[] = Array.isArray(reqHeaders)
    ? reqHeaders
    : reqHeaders !== null && typeof reqHeaders === 'object' ? Object.entries(reqHeaders) : []
  const headerList: [string, string][] = []
  for (const pair of pairs) {
    if (!Array.isArray(pair)) continue
    const name = fieldText(pair[0]), value = fieldText(pair[1])
    if (name !== undefined && value !== undefined) headerList.push([name, value])
  }
  let found: Plan['httpCred'] = null
  for (const [name, value] of headerList) {
    const ln = name.toLowerCase()
    if (ln === 'authorization') {
      const scheme = (value as string).split(' ')[0]?.toLowerCase() ?? ''
      const known = KNOWN_AUTH_SCHEMES[scheme]
      // An unrecognised scheme stops the scan either way: the header was an
      // Authorization header, so the weaker cookie/api-key heuristics below
      // would be describing the same request less accurately.
      if (known) found = { method: known.method, target: host, detail: known.detail }
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
        // A sender's `redactions` that is not a list is replaced by the spans
        // (spreading it would throw).
        const redactions = Array.isArray(data.redactions) ? data.redactions as unknown[] : []
        data.redactions = [...redactions, ...result.redacted.map((r) => ({ ...r, field }))]
      }
    }
  }
}

/** Test helper. */
export function _resetIngest(): void {
  clearPerProjectState()
  seenGeneration = dbGeneration()
  resetCausesResolver()
  lootDetectorRef = null
  alertRuntimeRef = null
  castProbe = null
  terminalLifecycle = null
}
