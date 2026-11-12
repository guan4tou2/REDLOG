import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { getDB, getProjectDir } from './db/index'
import { mkdirPrivate, restrictTree } from './private-fs'
import { queryEvents, insertEvent, loggedTierDigest } from './db/events'
import type { ExportCounts, ExportSnapshot, NormalizedExportRequest } from './export-plan'
import { eventBus } from './event-bus'
import { listAnchors, computeChainHead, chainHeadHash } from './chain-anchor'
import { listOperators, getPrimaryOperator, getPrimaryOperatorTokenHash } from './db/operators'
import { getSanitizedFields, countSanitizedEvents } from './sanitize'
import { isOutOfScope, isPersonalDomain, scopeMaskReplacements, type ScopeForSanitize } from './scope-sanitize'
import { BODY_REF_FOR, scopeBodyRefsToDrop } from './redact-export'
import { getDoNotExportIds } from './db/do-not-export'
import { isAttachmentId, type ExportAttachment } from './export-attachments'
import { BUNDLE_VERSION, SEAL_SUBTYPE, SEAL_VERSION, attachmentRefs, sealedManifestDigest, sha256Hex } from './evidence-rules'
import { verifyBundleDir } from './bundle-verify'

interface ManifestFile {
  path: string
  bytes: number
  sha256: string
}

export interface EvidenceBundle {
  outDir: string
  manifest: ManifestPayload
}

interface ManifestPayload {
  evidence: { kind: 'complete-chain' | 'projection'; transformedEventIds: string[]; sourceChain: { hash: string; eventCount: number } | null }
  bundleVersion: number
  createdAt: string
  hostname: string
  engagementId: string
  signedBy: { operatorId: string; operatorName: string; tokenHashPrefix: string } | null
  chainHead: { hash: string; eventCount: number } | null
  lastAnchor: { id: string; headHash: string; eventCount: number; status: string; createdAt: number } | null
  /** How many events in this bundle carry sanitized bytes instead of raw
   *  captured bytes (four-layer redaction, layer 4). Every one has a paired
   *  system.sanitized event in events.jsonl proving the swap was audited. */
  sanitized: { events: number; totalInDb: number }
  /** PRD A2: how many events had content fields masked because their target
   *  was out of scope (0 when no scope was supplied). */
  sanitizedOutOfScope: number
  personalDropped: number
  doNotExportDropped: number
  exportPlan?: { id: string; fingerprint: string; counts: ExportCounts; request?: NormalizedExportRequest }
  /** Row counts per tier. `chained` matches chainHead.eventCount and is the
   *  count the OTS anchor covers. `logged` is the events_logged row count. */
  tiers: { chained: number; logged: number; loggedDigest?: { count: number; sha256: string } }
  /** #222: what the operator left out, and which targets each included cast
   *  spans. Cast content is not rewritten (only its approved byte prefix is copied); one that spans several targets says so
   *  here rather than being presented as scope-clean. */
  attachments?: {
    excludedByOperator: string[]
    casts: Array<{ path: string; targets: string[]; attribution: ExportAttachment['attribution'] }>
    /** operator-added evidence files (#221) copied into `artifacts/` */
    artifacts: number
  }
  attachmentScopePolicy?: {
    screenshots: { included: number; excludedOutOfScope: number; unattributed: number }
    casts: { included: number; scopeFiltered: false; reason: string }
    httpBodies: { included: number; excludedOutOfScope: number }
  }
  /** §3.3: per-agent_type event count so consumers know which events are
   *  AI-reported (agent_type 'agent') versus directly observed. */
  eventSourceBreakdown?: Record<string, number>
  /** Present only when raw agent transcripts were copied in. They are the
   *  agent's transcript as written — not redacted, not scope-trimmed. */
  rawAgentTranscripts?: { redacted: false; files: RawTranscriptFile[] }
  files: ManifestFile[]
  /** v4. The id of the `system.export_sealed` row that is the last line of
   *  events.jsonl. A v4 bundle without it fails verification. */
  seal: { exportId: string }
  /** v4. Every attachment an event in this bundle refers to that the bundle
   *  does not carry, with why. Sealed, so a recipient can tell an omission
   *  the export made from a file removed afterwards. */
  omittedAttachments: Array<{ path: string; reason: string }>
}

/** Records this export's seal in the chain and returns the row as the bundle
 *  serialises it. In-process this is `writeExportSeal`; the export worker,
 *  whose database is read-only, asks main to run it (export-worker.ts). */
export type SealWriter = (engagementId: string, data: Record<string, unknown>) => Record<string, unknown>

const UNATTRIBUTED_EXPORT_OPERATOR = 'unattributed-export'

const EXPORTED_EVENT_COLUMNS = `id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms, signature`

/** Append the seal: a chained, signed `system.export_sealed` row by the
 *  primary operator. System rows are not held by a recording pause. Throws
 *  rather than returning an unsealed bundle that claims to be sealed. */
export function writeExportSeal(engagementId: string, data: Record<string, unknown>): Record<string, unknown> {
  if (data.subtype !== SEAL_SUBTYPE) throw new Error('Not an export seal')
  // A project with no primary operator has no key to sign with either; its
  // seal is an unsigned row like the rest of its chain, so the bundle still
  // verifies as consistent and NOT AUTHENTICATED rather than as unsealed.
  const operatorId = getPrimaryOperator()?.id ?? UNATTRIBUTED_EXPORT_OPERATOR
  const ev = insertEvent('system', data, { engagementId, operatorId })
  if (!ev) throw new Error('Export seal could not be recorded')
  eventBus.publish(ev)
  const row = getDB().prepare(`SELECT ${EXPORTED_EVENT_COLUMNS} FROM events WHERE id = ?`).get(ev.id) as Record<string, unknown> | undefined
  if (!row) throw new Error('Export seal could not be read back')
  return row
}

interface RawTranscriptFile extends ManifestFile {
  /** Read from the sidecar name when it has the tailer's shape. */
  agentKind?: string
  sessionId?: string
}

/** The tailer names a sidecar `${agentKind}-${sessionId}[-${activation}].jsonl`
 *  (tailer-host.ts). Agent kinds and session ids both contain dashes, so the
 *  split is only trusted when the session id is a UUID; any other name is
 *  listed by path alone rather than guessed at. */
const SIDECAR_NAME = /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?\.jsonl$/i
function transcriptNameParts(name: string): { agentKind?: string; sessionId?: string } {
  const m = SIDECAR_NAME.exec(name)
  return m ? { agentKind: m[1], sessionId: m[2] } : {}
}

function sha256File(p: string): { bytes: number; sha256: string } {
  const fd = fs.openSync(p, 'r')
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0, read = 0
  try {
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, read)); bytes += read }
  } finally { fs.closeSync(fd) }
  return { bytes, sha256: hash.digest('hex') }
}

function writeAndHash(dest: string, contents: string | Buffer): ManifestFile {
  fs.writeFileSync(dest, contents)
  const info = sha256File(dest)
  return { path: path.basename(dest), bytes: info.bytes, sha256: info.sha256 }
}

export interface ExportBundleOpts {
  outRoot?: string
  /** PRD A2: the engagement scope. When present, out-of-scope events have
   *  their captured content fields masked in the exported bundle (source DB
   *  and chain hash untouched). Omit to skip scope masking entirely — the safe
   *  default when the caller cannot supply scope. */
  scope?: ScopeForSanitize
  /** Turn scope masking off even when `scope` is supplied. Default on. */
  maskOutOfScope?: boolean
  /** v0.7.2 F: include the raw Claude Code and Codex
   *  transcripts from `<projectDir>/agent-transcripts/` in the bundle.
   *  DEFAULT FALSE. The sidecar `.jsonl` files are verbatim copies of the
   *  agent's own transcript, which may include operator-pasted secrets
   *  (API keys the operator typed into a Claude Code chat to test auth,
   *  passwords used in an example, etc.). The `agent.transcript_snapshot`
   *  event's sha256 lets an auditor verify the sidecar hasn't been
   *  tampered with WITHOUT them needing the raw file — so redacted export
   *  is the safe default, and this flag is the opt-in for engagements that
   *  legitimately need the pre-redaction content.
   *
   *  Refused (throws) together with `includeEventIds`: a sidecar is whole, so it
   *  cannot be trimmed to a plan-approved selection or time/session range;
   *  and together with scope masking, a snapshot, personal domains, or any
   *  do-not-export mark, none of which a sidecar can honour.
   *  Only `*.jsonl` transcripts are copied, and the manifest lists each under
   *  `rawAgentTranscripts` with `redacted: false`. */
  includeAgentTranscripts?: boolean
  snapshot?: ExportSnapshot
  /** Exact event selection approved by ExportPlan. When present, later policy
   * changes cannot silently widen or narrow the bundle. */
  includeEventIds?: ReadonlySet<string>
  exportPlan?: { id: string; fingerprint: string; counts: ExportCounts; request?: NormalizedExportRequest }
  /** Files the operator left out, by bundle-relative path (#222). */
  excludeAttachments?: ReadonlySet<string>
  /** The approved preview's attachment rows, recorded in the manifest so a
   *  recipient can see which targets each cast spans. */
  attachments?: readonly ExportAttachment[]
  /** The logged-tier digest, already computed by the caller over
   *  `snapshot.loggedMaxRowId` and already appended to the chain below
   *  `snapshot.chainedMaxRowId` (export-direct-bundle.ts). Recorded in the
   *  manifest as given; no digest is computed and no event is inserted. */
  loggedDigest?: LoggedTierDigest
  /** Where the seal is written. Defaults to `writeExportSeal` on this thread. */
  sealWriter?: SealWriter
}
export type LoggedTierDigest = ReturnType<typeof loggedTierDigest>

/** Copy the first `limit` bytes of `src` (all of it when `limit` is not smaller). */
function copyPrefix(src: string, dst: string, limit: number): void {
  if (limit >= fs.statSync(src).size) { fs.copyFileSync(src, dst); return }
  const fd = fs.openSync(src, 'r')
  try {
    const out = fs.openSync(dst, 'w')
    try {
      const buf = Buffer.allocUnsafe(Math.min(limit, 64 * 1024))
      let got = 0
      while (got < limit) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit - got), got)
        if (n === 0) throw new Error('Recording became shorter than its approved snapshot')
        fs.writeFileSync(out, buf.subarray(0, n))
        got += n
      }
    } finally { fs.closeSync(out) }
  } finally { fs.closeSync(fd) }
}

export function exportBundle(engagementId: string, opts: ExportBundleOpts): EvidenceBundle {
  // Before anything is written. A sidecar is the whole conversation, so it
  // cannot ride along with a selection that approved exact events.
  if (opts.includeAgentTranscripts && opts.includeEventIds) {
    throw new Error('Raw agent transcripts cannot be exported with a selection: a sidecar holds the whole conversation, not only the approved events.')
  }
  // Nor with scope masking: an out-of-scope target masked in events.jsonl
  // would still be in the raw transcript beside it, unmasked.
  if (opts.includeAgentTranscripts && opts.scope && opts.maskOutOfScope !== false) {
    throw new Error('Raw agent transcripts cannot be exported with scope masking: a sidecar is not masked, so it would carry what the events hide.')
  }
  // The rest narrow events.jsonl without a selection: a snapshot stops at the
  // approved row, personal domains and do-not-export marks drop rows. The
  // sidecar is copied live and whole, so it would still carry all of it.
  if (opts.includeAgentTranscripts && opts.snapshot) {
    throw new Error('Raw agent transcripts cannot be exported with a snapshot: a sidecar is copied live and would carry what was recorded after it.')
  }
  if (opts.includeAgentTranscripts && opts.scope?.personalDomains?.length) {
    throw new Error('Raw agent transcripts cannot be exported with personal domains: those events are dropped, but the sidecar would still carry them.')
  }
  if (opts.includeAgentTranscripts && getDoNotExportIds().size > 0) {
    throw new Error('Raw agent transcripts cannot be exported while events are marked do-not-export: those events are dropped, but the sidecar would still carry them.')
  }
  // __dirname resolves differently between dev (src/core/) and packaged
  // builds (out/main/). Try the same two-then-three-parents pattern
  // hooks-manager.ts uses for shipped assets, then fall back to cwd.
  const verifierCandidates = [
    path.join(__dirname, '..', '..', '..', 'tools', 'redlog-verify.py'),
    path.join(__dirname, '..', '..', 'tools', 'redlog-verify.py'),
    path.join(process.cwd(), 'tools', 'redlog-verify.py')
  ]
  // Resolved before anything is written: this bundle is sold as "with
  // verifier", so a build that lost the file (it was once not packaged at all)
  // must fail loudly here rather than ship a bundle a recipient cannot check.
  const verifierResolved = verifierCandidates.find((p) => fs.existsSync(p))
  if (!verifierResolved) {
    throw new Error(`Evidence bundle verifier not found — this RedLog build is missing tools/redlog-verify.py. Tried: ${verifierCandidates.join(', ')}`)
  }
  const outRoot = opts.outRoot
  const projectDir = getProjectDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bundleRoot = outRoot ?? path.join(projectDir, 'exports')
  const baseBundleDir = path.join(bundleRoot, `bundle-${ts}`)
  let finalBundleDir = baseBundleDir
  let suffix = 2
  while (fs.existsSync(finalBundleDir)) finalBundleDir = `${baseBundleDir}-${suffix++}`
  // Build under an unmistakably incomplete name. A failed copy or manifest
  // write can leave useful diagnostics behind, but recipients and callers must
  // never mistake that directory for a completed evidence bundle.
  const bundleDir = `${finalBundleDir}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  mkdirPrivate(bundleDir)

  const files: ManifestFile[] = []
  const excluded = opts.excludeAttachments ?? new Set<string>()
  // Why a file an exported event refers to was not copied; declared in the
  // manifest's sealed `omittedAttachments`.
  const omitReason = new Map<string, string>()
  /** The operator left it out, or the approved preview did not include it. */
  const leftOutByOperatorOrPlan = (id: string): boolean => {
    if (excluded.has(id)) { omitReason.set(id, 'excluded-by-operator'); return true }
    if (opts.attachments && !opts.attachments.some((a) => a.id === id && a.status === 'included')) {
      omitReason.set(id, opts.attachments.find((a) => a.id === id)?.status ?? 'not-in-approved-preview')
      return true
    }
    return false
  }

  const db = getDB()

  // v0.15 (docs/design/DESIGN-two-tier-chain.md §7.5 / §8): fold one cheap digest over
  // the logged tier and append it as a chained `system.logged_tier_digest`
  // event BEFORE the events.jsonl dump below for direct API exports, so
  // the snapshot ships inside that bundle's chained tier and the next OTS
  // anchor covers it. Planned exports cannot append a post-approval event to
  // their frozen selection; they record the bounded digest in the manifest.
  // This wires §8's own
  // escape hatch ("hash the logged tier and anchor the hash") into the automatic
  // anchor loop instead of leaving it a manual step, without touching the hot
  // logged write path. Skipped on an empty tier, mirroring the retention sweep's
  // "no rows → no event" rule. With ExportSnapshot this is bounded to the
  // exact logged tier approved by the operator; direct exports use the live tier.
  // the byte integrity of the (possibly sanitized) events_logged.jsonl copy is
  // the separate files[].sha256 entry recorded further down.
  // Resolve the signing operator up front: the digest snapshot below is a
  // chained `system` event and must carry an operatorId like any chained row
  // (insertEvent rejects a system event without one), and the manifest's
  // signedBy further down reuses this same primary. No primary operator → the
  // bundle is unsigned and the snapshot is skipped, not force-attributed.
  const primary = getPrimaryOperator()

  if (opts.loggedDigest && !opts.snapshot) throw new Error('A precomputed logged-tier digest needs the snapshot it was taken under')
  const loggedDigest = opts.loggedDigest ?? loggedTierDigest(opts.snapshot?.loggedMaxRowId)
  if (!opts.snapshot && loggedDigest.count > 0 && primary) {
    const ev = insertEvent('system', {
      subtype: 'logged_tier_digest',
      count: loggedDigest.count,
      sha256: loggedDigest.sha256,
      oldest_at: loggedDigest.oldest,
      newest_at: loggedDigest.newest,
      reason: 'export',
      description: `export: logged-tier snapshot — ${loggedDigest.count} row(s), sha256 ${loggedDigest.sha256.slice(0, 12)}…`
    }, { engagementId, operatorId: primary.id })
    if (ev) eventBus.publish(ev)
  }

  // 1. events.jsonl (in insertion order)
  const eventsPath = path.join(bundleDir, 'events.jsonl')
  const fd = fs.openSync(eventsPath, 'w')
  // events.jsonl is hashed as it is written: the seal commits to the bytes
  // before its own line, and the manifest to the whole file after it.
  const eventsHash = crypto.createHash('sha256')
  let eventsBytes = 0
  let lastDeliveredHash: string | null = null
  const writeEventLine = (row: Record<string, unknown>): void => {
    const line = Buffer.from(JSON.stringify(row) + '\n')
    fs.writeSync(fd, line)
    eventsHash.update(line)
    eventsBytes += line.length
  }
  // Attachments the delivered rows refer to, and why any of them is left out.
  const referencedAttachments = new Set<string>()
  const noteRefs = (agentType: string, d: Record<string, unknown>): void => {
    for (const ref of attachmentRefs(agentType, d)) referencedAttachments.add(ref.path)
  }
  const snap = opts.snapshot
  const chainedBound = snap ? ' WHERE rowid <= ?' : ''
  let chainedRowCount = 0
  const transformedEventIds: string[] = []
  const rowIter = db.prepare(
    `SELECT ${EXPORTED_EVENT_COLUMNS}
     FROM events${chainedBound} ORDER BY created_at ASC, rowid ASC`
  ).iterate(...(snap ? [snap.chainedMaxRowId] : [])) as IterableIterator<Record<string, unknown>>
  // Four-layer redaction, layer 4: when an event has a sanitized replacement
  // in the sanitized_events table, swap the raw field bytes for the sanitized
  // copy AS WRITTEN TO THE BUNDLE. The source DB row is untouched — the swap
  // only affects the exported file. The row's `hash` field still refers to
  // the original bytes; auditors verifying the chain need the source DB or
  // the paired system.sanitized event to reconcile.
  let sanitizedRowsWritten = 0
  let outOfScopeMasked = 0
  let personalDropped = 0
  let doNotExportDropped = 0
  const scope = opts.maskOutOfScope === false ? undefined : opts.scope
  const doNotExportIds = getDoNotExportIds()
  const survivingBodyRefs = new Set<string>()
  // Operator-added artifacts (#221) travel only with an exported event.
  const survivingArtifacts = new Set<string>()
  const sourceBreakdown: Record<string, number> = {}
  for (const row of rowIter) {
    if (opts.includeEventIds && !opts.includeEventIds.has(row.id as string)) continue
    if (!opts.includeEventIds && doNotExportIds.has(row.id as string)) {
      doNotExportDropped++
      continue
    }
    if (!opts.includeEventIds && isPersonalDomain(row.target_id as string | null, opts.scope)) {
      personalDropped++
      continue
    }
    const eventId = row.id as string
    const agentType = (row.agent_type as string) ?? 'unknown'
    sourceBreakdown[agentType] = (sourceBreakdown[agentType] ?? 0) + 1
    const replacements = getSanitizedFields(eventId)
    let data: Record<string, unknown> | null = null
    if (Object.keys(replacements).length > 0) {
      try {
        data = JSON.parse(row.data as string) as Record<string, unknown>
        for (const [field, value] of Object.entries(replacements)) data[field] = value
        sanitizedRowsWritten++
      } catch { data = null }
    }
    if (scope) {
      try {
        if (!data) data = JSON.parse(row.data as string) as Record<string, unknown>
        const scopeRepl = scopeMaskReplacements(data, row.target_id as string | null, scope)
        // A preview-less body has only its ref; drop every ref, not just the
        // ones whose preview was masked (#489).
        const refsDropped = scopeBodyRefsToDrop(data, row.target_id as string | null, scope)
        if (scopeRepl || refsDropped.length > 0) {
          for (const [f, v] of Object.entries(scopeRepl ?? {})) data[f] = v
          for (const ref of refsDropped) delete data[ref]
          outOfScopeMasked++
        }
      } catch { /* leave row as-is */ }
    }
    if (data) {
      const delivered = JSON.stringify(data)
      if (delivered !== row.data) transformedEventIds.push(row.id as string)
      row.data = delivered
    }
    // Collect surviving body-store refs so http-bodies/ can be scope-filtered.
    try {
      const d = data ?? (JSON.parse(row.data as string) as Record<string, unknown>)
      for (const refKey of Object.values(BODY_REF_FOR)) {
        const ref = d[refKey]
        if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).sha256 === 'string') {
          survivingBodyRefs.add((ref as Record<string, unknown>).sha256 as string)
        }
      }
      if (agentType === 'file_transfer' && d.subtype === 'artifact_added' && isAttachmentId(d.stored) && d.stored.startsWith('artifacts/')) {
        if (!(scope && isOutOfScope(row.target_id as string | null, scope))) survivingArtifacts.add(d.stored)
        else omitReason.set(d.stored, 'out-of-scope')
      }
      noteRefs(agentType, d)
    } catch { /* parse already failed above; skip */ }
    writeEventLine(row)
    lastDeliveredHash = (row.hash as string | null) ?? null
    chainedRowCount++
  }

  // 1b. v0.13.0: events_logged.jsonl — the supporting-evidence tier
  // (docs/design/DESIGN-two-tier-chain.md sec.7.1). Same insertion-order dump as
  // events.jsonl, minus the chain columns (they are always NULL on
  // logged rows). The bundled verifier IGNORES this file with a summary
  // line; only the chained tier is part of the audit-verified chain.
  //
  // Sanitization: the four-layer swap runs against logged rows too, since
  // a DNS query URL can carry a token. Because there's no per-row hash to
  // reconcile against, the in-memory rewrite is enough — no separate
  // sanitized_events_logged bookkeeping table.
  const eventsLoggedPath = path.join(bundleDir, 'events_logged.jsonl')
  const loggedFd = fs.openSync(eventsLoggedPath, 'w')
  const loggedBound = snap ? ' WHERE rowid <= ?' : ''
  const loggedIter = db.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, created_at
     FROM events_logged${loggedBound} ORDER BY created_at ASC, rowid ASC`
  ).iterate(...(snap ? [snap.loggedMaxRowId] : [])) as IterableIterator<Record<string, unknown>>
  let loggedRowCount = 0
  for (const row of loggedIter) {
    if (opts.includeEventIds && !opts.includeEventIds.has(row.id as string)) continue
    if (!opts.includeEventIds && doNotExportIds.has(row.id as string)) {
      doNotExportDropped++
      continue
    }
    if (!opts.includeEventIds && isPersonalDomain(row.target_id as string | null, opts.scope)) {
      personalDropped++
      continue
    }
    const eventId = row.id as string
    const replacements = getSanitizedFields(eventId)
    let data: Record<string, unknown> | null = null
    if (Object.keys(replacements).length > 0) {
      try {
        data = JSON.parse(row.data as string) as Record<string, unknown>
        for (const [field, value] of Object.entries(replacements)) data[field] = value
        sanitizedRowsWritten++
      } catch { data = null }
    }
    if (scope) {
      try {
        if (!data) data = JSON.parse(row.data as string) as Record<string, unknown>
        const scopeRepl = scopeMaskReplacements(data, row.target_id as string | null, scope)
        // A preview-less body has only its ref; drop every ref, not just the
        // ones whose preview was masked (#489).
        const refsDropped = scopeBodyRefsToDrop(data, row.target_id as string | null, scope)
        if (scopeRepl || refsDropped.length > 0) {
          for (const [f, v] of Object.entries(scopeRepl ?? {})) data[f] = v
          for (const ref of refsDropped) delete data[ref]
          outOfScopeMasked++
        }
      } catch { /* leave row as-is */ }
    }
    if (data) {
      const delivered = JSON.stringify(data)
      if (delivered !== row.data) transformedEventIds.push(row.id as string)
      row.data = delivered
    }
    // Collect surviving body-store refs from logged tier too.
    try {
      const d = data ?? (JSON.parse(row.data as string) as Record<string, unknown>)
      for (const refKey of Object.values(BODY_REF_FOR)) {
        const ref = d[refKey]
        if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).sha256 === 'string') {
          survivingBodyRefs.add((ref as Record<string, unknown>).sha256 as string)
        }
      }
      noteRefs((row.agent_type as string) ?? 'unknown', d)
    } catch { /* skip */ }
    fs.writeSync(loggedFd, JSON.stringify(row) + '\n')
    loggedRowCount++
  }
  fs.closeSync(loggedFd)
  files.push({ path: 'events_logged.jsonl', ...sha256File(eventsLoggedPath) })

  // 3. chain_anchors.json — includes calendar receipts (verifiable off-machine)
  files.push(writeAndHash(
    path.join(bundleDir, 'chain_anchors.json'),
    JSON.stringify(listAnchors(10000), null, 2)
  ))

  // 4. operators.json — public fields only (no token hashes).
  // v0.6.94: include signerPubKey so a standalone verifier (tools/redlog-verify.py)
  // can validate Ed25519 signatures without touching the RedLog DB. The pubkey
  // is not secret — it's the counterpart to the private signing key that stays
  // in ~/.redlog/keys/<operator>.key.
  files.push(writeAndHash(
    path.join(bundleDir, 'operators.json'),
    JSON.stringify(listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt,
      signerPubKey: op.signerPubKey
    })), null, 2)
  ))

  // 5. screenshots/  — copy jpegs, scope-filtering when maskOutOfScope is on.
  // Audit 2026-09-18 §2.3: screenshot events carry `data.filename` + `target_id`;
  // when scope masking is active, exclude files whose event target is out of scope.
  // Files with no matching event or no target are included but counted as unattributed.
  const srcShots = path.join(projectDir, 'screenshots')
  const dstShots = path.join(bundleDir, 'screenshots')
  let screenshotsIncluded = 0
  let screenshotsExcluded = 0
  let screenshotsUnattributed = 0
  if (fs.existsSync(srcShots)) {
    const shotFilenameToTarget = new Map<string, string | null>()
    if (scope) {
      const shotRows = db.prepare(
        `SELECT json_extract(data, '$.filename') AS filename, target_id
         FROM events WHERE agent_type = 'screenshot'`
      ).all() as Array<{ filename: string | null; target_id: string | null }>
      for (const r of shotRows) {
        if (r.filename) shotFilenameToTarget.set(r.filename, r.target_id)
      }
    }
    let dirCreated = false
    for (const name of fs.readdirSync(srcShots)) {
      const s = path.join(srcShots, name)
      if (!fs.statSync(s).isFile()) continue
      if (leftOutByOperatorOrPlan(`screenshots/${name}`)) continue
      {
        const target = shotFilenameToTarget.get(name)
        if (isPersonalDomain(target ?? null, opts.scope)) {
          screenshotsExcluded++
          omitReason.set(`screenshots/${name}`, 'personal-domain')
          continue
        }
        if (scope) {
          if (target === undefined) {
            screenshotsUnattributed++
          } else if (!target) {
            screenshotsUnattributed++
          } else if (isOutOfScope(target, scope)) {
            screenshotsExcluded++
            omitReason.set(`screenshots/${name}`, 'out-of-scope')
            continue
          }
        }
      }
      if (!dirCreated) { fs.mkdirSync(dstShots, { recursive: true }); dirCreated = true }
      const d = path.join(dstShots, name)
      fs.copyFileSync(s, d)
      const info = sha256File(d)
      files.push({ path: `screenshots/${name}`, ...info })
      screenshotsIncluded++
    }
  }

  // 6. casts/ — copy every asciinema cast if present.
  // Audit 2026-09-18 §2.3: casts span multiple commands/targets within a single
  // terminal session — automatic scope filtering would require byte-level
  // splitting, which the audit explicitly deems unsafe ("不承諾自動裁切即可安全").
  // Preserve the approved prefix byte-for-byte. Bundle does not support
  // operator-PII scrubbing; a silent rewrite would invalidate io offsets.
  const srcCasts = path.join(projectDir, 'casts')
  const dstCasts = path.join(bundleDir, 'casts')
  let castsIncluded = 0
  if (fs.existsSync(srcCasts)) {
    fs.mkdirSync(dstCasts, { recursive: true })
    for (const name of fs.readdirSync(srcCasts)) {
      if (leftOutByOperatorOrPlan(`casts/${name}`)) continue
      const s = path.join(srcCasts, name)
      const d = path.join(dstCasts, name)
      if (fs.statSync(s).isFile()) {
        copyPrefix(s, d, opts.attachments?.find((a) => a.id === `casts/${name}`)?.frozenBytes ?? Infinity)
        const info = sha256File(d)
        files.push({ path: `casts/${name}`, ...info })
        castsIncluded++
      }
    }
  }

  // 6a. http-bodies/ — copy referenced body files so the bundle is self-contained.
  // When scope masking is active, only copy files whose sha256 is still
  // referenced by a surviving *_ref pointer — bodies whose refs were dropped
  // (because the corresponding content field was scope-masked) are excluded so
  // a bundle consumer cannot recover the un-redacted original.
  const srcBodies = path.join(projectDir, 'http-bodies')
  let httpBodiesIncluded = 0
  let httpBodiesExcluded = 0
  if (fs.existsSync(srcBodies)) {
    const dstBodies = path.join(bundleDir, 'http-bodies')
    const bodyFiles = fs.readdirSync(srcBodies).filter((n) => n.endsWith('.body'))
    if (bodyFiles.length > 0) {
      let dirCreated = false
      for (const name of bodyFiles) {
        if (leftOutByOperatorOrPlan(`http-bodies/${name}`)) continue
        if (scope) {
          const hash = name.replace(/\.body$/, '')
          if (!survivingBodyRefs.has(hash)) { httpBodiesExcluded++; omitReason.set(`http-bodies/${name}`, 'out-of-scope'); continue }
        }
        if (!dirCreated) { fs.mkdirSync(dstBodies, { recursive: true }); dirCreated = true }
        const s = path.join(srcBodies, name)
        const d = path.join(dstBodies, name)
        if (fs.statSync(s).isFile()) {
          fs.copyFileSync(s, d)
          const info = sha256File(d)
          files.push({ path: `http-bodies/${name}`, ...info })
          httpBodiesIncluded++
        }
      }
    }
  }

  // 6c. artifacts/ — files the operator added as evidence (#221). Copied
  // byte-for-byte: the sha256 in the event that added each one must match.
  let artifactsIncluded = 0
  for (const id of [...survivingArtifacts].sort()) {
    if (leftOutByOperatorOrPlan(id)) continue
    const s = path.join(projectDir, id)
    if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue
    const d = path.join(bundleDir, id)
    fs.mkdirSync(path.dirname(d), { recursive: true })
    fs.copyFileSync(s, d)
    files.push({ path: id, ...sha256File(d) })
    artifactsIncluded++
  }

  // 6b. agent-transcripts/ — copied ONLY when opts.includeAgentTranscripts.
  // Default-exclude rationale: the raw sidecar `.jsonl` files hold verbatim
  // conversation content (user prompts + assistant responses + tool_use +
  // tool_result), which may include operator-pasted secrets. The DB-side
  // events these transcripts derive are already redacted (v0.7.2 A ports
  // the shell-hook regex into src/core/redaction.ts) and DO ship in
  // events.jsonl. Whole-file sha256 lives in `agent.transcript_snapshot`
  // events, so an auditor can prove tamper-freedom without seeing the
  // raw bytes — they only need the raw file for content review, which is
  // an opt-in choice.
  // Only the transcripts themselves (`*.jsonl`): the tailer's `.offset.json`
  // checkpoints and boundary file are bookkeeping, not conversation. Each one
  // copied is listed in `manifest.rawAgentTranscripts`, marked unredacted.
  let rawAgentTranscripts: ManifestPayload['rawAgentTranscripts']
  if (opts.includeAgentTranscripts) {
    const srcAgent = path.join(projectDir, 'agent-transcripts')
    const dstAgent = path.join(bundleDir, 'agent-transcripts')
    const raw: RawTranscriptFile[] = []
    if (fs.existsSync(srcAgent)) {
      for (const name of fs.readdirSync(srcAgent).filter((n) => n.endsWith('.jsonl')).sort()) {
        const s = path.join(srcAgent, name)
        if (!fs.statSync(s).isFile()) continue
        fs.mkdirSync(dstAgent, { recursive: true })
        const d = path.join(dstAgent, name)
        fs.copyFileSync(s, d)
        const info = sha256File(d)
        files.push({ path: `agent-transcripts/${name}`, ...info })
        raw.push({ path: `agent-transcripts/${name}`, sha256: info.sha256, bytes: info.bytes, ...transcriptNameParts(name) })
      }
    }
    rawAgentTranscripts = { redacted: false, files: raw }
  }

  // v0.6.94 C: ship a standalone chain verifier inside the bundle so the
  // recipient can prove tamper-freedom without installing Node/Electron/
  // better-sqlite3. Python 3 stdlib is enough for the hash chain; Ed25519
  // signature verification is optional (`uv run --with cryptography`).
  // See tools/redlog-verify.py and docs/CLOUD_SHARE_BUNDLE.md.
  // The verifier, its OS wrappers and the recipient README.
  {
    const verifierBytes = fs.readFileSync(verifierResolved)
    const verifierDest = path.join(bundleDir, 'redlog-verify.py')
    fs.writeFileSync(verifierDest, verifierBytes)
    const info = sha256File(verifierDest)
    files.push({ path: 'redlog-verify.py', ...info })

    const shWrapper = [
      '#!/usr/bin/env bash',
      '# RedLog bundle verifier — thin wrapper around redlog-verify.py.',
      '# Requires: python3. Checking Ed25519 signatures also needs the',
      '# `cryptography` package; without it a signed bundle FAILS (exit 1):',
      '#   uv run --with cryptography redlog-verify.py .',
      '# Exit 0 = authenticated (or --hash-only), 1 = failed,',
      '# 3 = hash chain consistent but NOT AUTHENTICATED (no signatures),',
      '# 4 = an attachment differs from the digest recorded at capture,',
      '# 5 = the bundle differs from what its export sealed.',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'exec python3 "$DIR/redlog-verify.py" "$DIR" "$@"',
      ''
    ].join('\n')
    const shDest = path.join(bundleDir, 'verify.sh')
    fs.writeFileSync(shDest, shWrapper, { mode: 0o755 })
    files.push({ path: 'verify.sh', ...sha256File(shDest) })

    // A tiny cmd.exe wrapper so Windows recipients can double-click / run
    // `verify.cmd` — same UX as `bash verify.sh`.
    const cmdWrapper = [
      '@echo off',
      'REM RedLog bundle verifier — thin wrapper around redlog-verify.py.',
      'REM Requires: python3 on PATH, plus `cryptography` to check signatures.',
      'REM Exit 0 = authenticated (or --hash-only), 1 = failed, 3 = not authenticated,',
      'REM 4 = attachment differs from its capture digest, 5 = differs from the export seal.',
      'python "%~dp0redlog-verify.py" "%~dp0." %*',
      ''
    ].join('\r\n')
    const cmdDest = path.join(bundleDir, 'verify.cmd')
    fs.writeFileSync(cmdDest, cmdWrapper)
    files.push({ path: 'verify.cmd', ...sha256File(cmdDest) })

    // Tiny README so the recipient knows what button to press.
    const readme = [
      '# RedLog evidence bundle',
      '',
      '## What is in this bundle',
      '',
      '- **events.jsonl** — the audit chain. Every row is SHA-256-linked to the',
      '  previous row, Ed25519-signed by the operator key, and covered by the',
      '  OpenTimestamps anchor in `chain_anchors.json`. Treat this as **primary',
      '  evidence** — the rows a court or auditor should read for facts.',
      '- **events_logged.jsonl** — supporting footprint (v0.13.0+). DNS lookups,',
      '  HTTP flow bookkeeping, CDP console lines, agent thinking, alert-bus',
      '  heartbeats. Linked back into `events.jsonl` via `_causes` where a causal',
      '  relationship is known. **NOT hash-chained, NOT signed, NOT anchored.**',
      '  Treat as investigative context, not primary evidence.',
      '',
      'The verifier below walks `events.jsonl` only; the logged tier is present',
      'for completeness but is not part of the audit-verified chain.',
      '',
      '`manifest.evidence` declares complete-chain versus projection, and lists',
      'the transformed IDs. A projection omits records or transforms delivery',
      'fields; its original hashes are retained, not recomputed into an invented',
      'chain. The verifier checks file digests and unchanged source rows — it',
      'cannot verify the source bytes of a transformed row, nor prove the',
      'original chain was complete from a subset. A whole-session cast is not',
      'trimmed by an event filter and may span other targets.',
      '',
      'A complete-chain bundle contains the entire source chain and verifies',
      'its links and head. A projection retains original row identities and',
      'hashes, but intentionally omits or masks evidence according to the',
      'approved selection and policies. Its successful verification means',
      'the delivered files and eligible unchanged rows verified; it never',
      'establishes the completeness of the original source chain.',
      '',
      '## Verify (macOS / Linux)',
      '',
      '```',
      'bash verify.sh',
      '```',
      '',
      '## Verify (Windows)',
      '',
      '```',
      'verify.cmd',
      '```',
      '',
      'Both wrappers invoke `python3 redlog-verify.py .` (Python 3.8+). Hashes',
      'alone only show the bundle is consistent with itself; anyone holding it',
      'could have rewritten and re-hashed it. Events are therefore signed, and',
      'checking the Ed25519 signatures needs the `cryptography` package. Run the',
      'verifier through uv, which supplies it without installing anything:',
      '',
      '```',
      'uv run --with cryptography redlog-verify.py .',
      '```',
      '',
      'Exit codes: 0 authenticated, 1 failed (including an unsigned event or a',
      'signature that cannot be checked), 3 hash chain consistent but NOT',
      'AUTHENTICATED (nothing signed), 4 a screenshot, cast, HTTP body, artifact',
      'or transcript differs from the sha256 its event recorded at capture (or',
      'an event refers to one that is absent and not declared omitted), 5 the',
      'bundle differs from what its export sealed. `--hash-only` reports the',
      'chain without authentication and exits 0 instead of 3; it does not',
      'accept 4 or 5. Each signer\'s public-key SHA-256 fingerprint is printed;',
      'compare it with the operator out of band.',
      '',
      'The last row of `events.jsonl` is this export\'s seal',
      '(`system.export_sealed`), signed like every other row. It commits to the',
      'rows before it and to `manifest.json` (all of it except the seal block',
      'and the events.jsonl entry), so the file list, the declared omissions',
      'and the export\'s boundary cannot be changed without failing. It cannot',
      'show that rows were not removed before the export, or that the seal',
      'itself was not cut off together with the rows before it: only the',
      'OpenTimestamps anchors, compared with a copy held elsewhere, can.',
      '`--require-seal` makes an unsealed bundle fail.',
      '',
      'The verifier reads `manifest.json`, `events.jsonl`, and `operators.json`',
      'from this directory and prints a summary: events walked, chain intact or',
      'broken at event X, signature verified counts. If `events_logged.jsonl` is',
      'present, the verifier reports its row count with a "not verified —',
      'supporting evidence" note.',
      ''
    ].join('\n')
    const readmeDest = path.join(bundleDir, 'README.md')
    fs.writeFileSync(readmeDest, readme)
    files.push({ path: 'README.md', ...sha256File(readmeDest) })
  }

  // A planned export must describe the same chain boundary the operator
  // previewed.  Using the live head here would let an event inserted between
  // preview and execution leak into manifest metadata even though events.jsonl
  // is correctly bounded by the snapshot.
  const head = snap
    ? (() => {
        const countRow = db.prepare(
          'SELECT COUNT(*) AS count FROM events WHERE rowid <= ? AND hash IS NOT NULL'
        ).get(snap.chainedMaxRowId) as { count: number }
        const row = db.prepare(
          `SELECT id, hash FROM events
           WHERE rowid <= ? AND hash IS NOT NULL
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        ).get(snap.chainedMaxRowId) as { id: string; hash: string } | undefined
        return row ? { hash: chainHeadHash(row.hash, countRow.count), headEventId: row.id, eventCount: countRow.count } : null
      })()
    : computeChainHead()
  const lastAnchor = listAnchors(1)[0] ?? null
  const primaryTokenHash = getPrimaryOperatorTokenHash()

  // A bundle is a projection when it carries less than the whole chain, or
  // anything in it was transformed.  A filtered selection is the third way
  // that happens, and the one the manifest could not say before (spec 056).
  const projection = transformedEventIds.length > 0 || chainedRowCount !== (head?.eventCount ?? 0) || loggedRowCount !== loggedDigest.count || (opts.exportPlan?.request?.subset.kind != null && opts.exportPlan.request.subset.kind !== 'all')

  // Every attachment a delivered row refers to and the bundle does not carry,
  // with the reason. Sealed with the manifest, so a recipient can tell a file
  // this export left out from one removed afterwards.
  const shipped = new Set(files.map((f) => f.path))
  const omittedAttachments = [...referencedAttachments].filter((p) => !shipped.has(p)).sort().map((p) => ({
    path: p,
    reason: omitReason.get(p)
      ?? (p.startsWith('agent-transcripts/') && !opts.includeAgentTranscripts ? 'raw-transcripts-not-requested'
        : fs.existsSync(path.join(projectDir, p)) ? 'not-exported' : 'not-on-disk')
  }))
  const exportId = crypto.randomUUID()

  const manifest: ManifestPayload = {
    evidence: { kind: projection ? 'projection' : 'complete-chain', transformedEventIds, sourceChain: head ? { hash: head.hash, eventCount: head.eventCount } : null },
    // Current evidence-bundle schema identifier.
    bundleVersion: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    engagementId,
    signedBy: primary && primaryTokenHash ? {
      operatorId: primary.id,
      operatorName: primary.name,
      tokenHashPrefix: primaryTokenHash.slice(0, 16)
    } : null,
    chainHead: head ? { hash: head.hash, eventCount: head.eventCount } : null,
    lastAnchor: lastAnchor ? {
      id: lastAnchor.id,
      headHash: lastAnchor.headHash,
      eventCount: lastAnchor.eventCount,
      status: lastAnchor.status,
      createdAt: lastAnchor.createdAt
    } : null,
    sanitized: { events: sanitizedRowsWritten, totalInDb: countSanitizedEvents() },
    sanitizedOutOfScope: outOfScopeMasked,
    // Planned policy counts describe the approved candidate population, not
    // every omitted source row (a filtered subset can omit unrelated rows).
    personalDropped: opts.includeEventIds && opts.exportPlan ? opts.exportPlan.counts.excludedPersonal : personalDropped,
    doNotExportDropped: opts.includeEventIds && opts.exportPlan ? opts.exportPlan.counts.excludedDoNotExport : doNotExportDropped,
    exportPlan: opts.exportPlan,
    attachments: {
      excludedByOperator: [...excluded].sort(),
      casts: (opts.attachments ?? [])
        .filter((a) => a.kind === 'cast' && a.status === 'included')
        .map((a) => ({ path: a.id, targets: a.targets, attribution: a.attribution })),
      artifacts: artifactsIncluded
    },
    attachmentScopePolicy: scope ? {
      screenshots: { included: screenshotsIncluded, excludedOutOfScope: screenshotsExcluded, unattributed: screenshotsUnattributed },
      casts: { included: castsIncluded, scopeFiltered: false as const, reason: 'casts span multiple targets; automatic trimming unsafe' },
      httpBodies: { included: httpBodiesIncluded, excludedOutOfScope: httpBodiesExcluded }
    } : undefined,
    eventSourceBreakdown: sourceBreakdown,
    rawAgentTranscripts,
    tiers: {
      // Planned exports describe the approved snapshot. Direct exports use
      // the live head, including the digest event emitted above. The seal,
      // the last line of events.jsonl, is counted; chainHead stops before it.
      chained: chainedRowCount + 1,
      logged: loggedRowCount,
      // §7.5: the anchored snapshot of the logged tier taken above. Surfaced
      // here so a consumer reading manifest.json sees the count + hash without
      // walking events.jsonl for the system.logged_tier_digest event.
      loggedDigest: loggedDigest.count > 0
        ? { count: loggedDigest.count, sha256: loggedDigest.sha256 }
        : undefined
    },
    files,
    seal: { exportId },
    omittedAttachments
  }

  // The seal (docs/audit-trail.md "Export seal"). It commits to the rows
  // before it — their count, the last one's hash and the bytes they occupy in
  // events.jsonl — and to the manifest without its seal block and without the
  // events.jsonl entry, the only two things written after it. It is chained
  // and signed like any row, by main: in the export worker `sealWriter` asks
  // main to insert it, and the row comes back to be appended here, because the
  // worker's read transaction cannot see it. Rows recorded between this
  // export's boundary and the seal are not in the bundle; the seal is exempt
  // from linking to the row before it, and says what it follows instead.
  const sealData = {
    subtype: SEAL_SUBTYPE,
    sealVersion: SEAL_VERSION,
    exportId,
    bundleVersion: BUNDLE_VERSION,
    manifestSha256: sealedManifestDigest(manifest as unknown as Record<string, unknown>),
    events: { count: chainedRowCount, bytes: eventsBytes, sha256: eventsHash.copy().digest('hex'), headHash: lastDeliveredHash },
    description: `export sealed: ${chainedRowCount} chained row(s), ${files.length} file(s), ${omittedAttachments.length} omitted attachment(s)`
  }
  const sealRow = (opts.sealWriter ?? writeExportSeal)(engagementId, sealData)
  writeEventLine(sealRow)
  fs.closeSync(fd)
  files.unshift({ path: 'events.jsonl', bytes: eventsBytes, sha256: eventsHash.digest('hex') })

  const manifestPath = path.join(bundleDir, 'manifest.json')
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
  fs.writeFileSync(manifestPath, manifestBytes)

  const manifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex')
  fs.writeFileSync(path.join(bundleDir, 'manifest.sha256'), manifestSha + '\n')

  if (primaryTokenHash) {
    const hmac = crypto.createHmac('sha256', primaryTokenHash).update(manifestBytes).digest('hex')
    fs.writeFileSync(
      path.join(bundleDir, 'manifest.hmac'),
      `hmac_sha256=${hmac}\ntoken_hash_prefix=${primaryTokenHash.slice(0, 16)}\nalgo=HMAC-SHA256(token_hash, manifest.json)\n`
    )
  }

  // Read back under the recipient's rules before it is handed over. A seal or
  // manifest the verifier would reject is this exporter's fault, so the export
  // fails. A broken source chain or an attachment that no longer matches its
  // capture digest is the project's state, faithfully delivered: the
  // recipient's verifier reports it, so it does not stop the export.
  const self = verifyBundleDir(bundleDir, { hashOnly: true, selfCheck: true })
  if (self.category === 'malformed' || self.category === 'sealMismatch') {
    throw new Error(`Evidence bundle failed its own verification: ${self.problems.join('; ')}`)
  }

  // Copies keep the source's mode and several files are opened without one, so
  // the bundle is restricted as a whole once it is complete.
  restrictTree(bundleDir)
  fs.renameSync(bundleDir, finalBundleDir)
  return { outDir: finalBundleDir, manifest }
}
