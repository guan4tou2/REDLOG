// The in-app reading of an evidence bundle: the same rules, the same order and
// the same exit codes as tools/redlog-verify.py, which is what a recipient
// runs. Every bundle the app writes is put through this before it is handed
// over (bundle-export.ts), and test/evidence-vectors.test.ts runs both
// verifiers over the same tampered bundles and requires the same verdict.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { verifyEventSignature } from './signing'
import {
  ATTACHMENT_DIRS, BUNDLE_VERSION, SEAL_SUBTYPE, SEAL_VERSION, VERIFY_EXIT, attachmentRefs, authenticationVerdict,
  chainedRowCanonical, sealedManifestDigest, sha256Hex, type AttachmentRef, type VerifyCategory
} from './evidence-rules'
import { canonicalStringify } from './db/event-write'
import { compareCodeUnits } from './code-unit-order'

export interface BundleVerifyOptions {
  hashOnly?: boolean
  /** Treat a bundle without a seal as a seal failure (exit 5). */
  requireSeal?: boolean
  /** The exporter checking what it just wrote: file digests are taken from
   *  the manifest it computed them for, and the logged tier is not re-read. */
  selfCheck?: boolean
}

export interface BundleVerdict {
  exitCode: number
  category: VerifyCategory
  /** why the verdict is not `verified`, one line each */
  problems: string[]
  seal: 'sealed' | 'not-sealed' | 'mismatch'
  attachments: {
    bound: string[]
    boundUnverifiedRow: string[]
    unbound: string[]
    mismatched: string[]
    omittedDeclared: Array<{ path: string; reason: string }>
    missingUndeclared: string[]
    unlisted: string[]
  }
}

/** v4 manifest fields. Anything else in a v4 manifest is a field this
 *  verifier would be ignoring, so it refuses rather than passes. */
const V4_MANIFEST_KEYS = new Set([
  'evidence', 'bundleVersion', 'createdAt', 'hostname', 'engagementId', 'signedBy', 'chainHead', 'lastAnchor',
  'sanitized', 'sanitizedOutOfScope', 'personalDropped', 'doNotExportDropped', 'exportPlan', 'tiers', 'attachments',
  'attachmentScopePolicy', 'eventSourceBreakdown', 'rawAgentTranscripts', 'files', 'seal', 'omittedAttachments'
])
/** The seal's own fields, plus the two receiver keys a seal row can carry.
 *  They are not seal fields and nothing in the seal check reads them;
 *  refusing them refused every seal written with them.
 *   - `_ingest`: the receiver stamps every new row (Spec 071 FR-005).
 *   - `_clock_anomaly`: insertEvent adds it to any chained row written while
 *     the clock is off (NTP offset past 30 s, monotonic regression).
 *  No other: insertEvent adds `_raw` only for an envelope carrying raw bytes
 *  and `_source_time_rejected` only for a producer-supplied time, and
 *  writeExportSeal passes neither. Anything else is a seal format this
 *  verifier does not know. tools/redlog-verify.py holds the same set. */
const SEAL_DATA_KEYS = new Set(['subtype', 'sealVersion', 'exportId', 'bundleVersion', 'manifestSha256', 'events', 'description',
  '_ingest', '_clock_anomaly'])
const SEAL_EVENTS_KEYS = new Set(['count', 'bytes', 'sha256', 'headHash'])

type Row = Record<string, unknown>
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function hashFile(file: string, limit = Infinity): { sha256: string; bytes: number } {
  const fd = fs.openSync(file, 'r')
  const h = crypto.createHash('sha256'), buf = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0
  try {
    for (;;) {
      const want = Math.min(buf.length, limit - bytes)
      if (want <= 0) break
      const n = fs.readSync(fd, buf, 0, want, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n)); bytes += n
    }
  } finally { fs.closeSync(fd) }
  return { sha256: h.digest('hex'), bytes }
}

/** Each non-blank line with the byte offset it starts at. */
function* lines(file: string): Generator<{ offset: number; text: string }> {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  let carry = Buffer.alloc(0), carryAt = 0
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
      let start = 0
      for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
        const text = chunk.subarray(start, nl).toString('utf8').trim()
        if (text) yield { offset: carryAt + start, text }
        start = nl + 1
      }
      carry = chunk.subarray(start); carryAt += start
    }
    const tail = carry.toString('utf8').trim()
    if (tail) yield { offset: carryAt, text: tail }
  } finally { fs.closeSync(fd) }
}

function parseLine(file: string, n: number, text: string): Row {
  try { return JSON.parse(text) as Row } catch (e) { throw new BundleMalformed(`malformed ${file} at line ${n}: ${(e as Error).message}`) }
}
class BundleMalformed extends Error {}

function parsedData(row: Row): unknown {
  if (typeof row.data !== 'string') return row.data
  try { return JSON.parse(row.data) } catch { return row.data }
}

export function verifyBundleDir(dir: string, opts: BundleVerifyOptions = {}): BundleVerdict {
  const attachments: BundleVerdict['attachments'] = { bound: [], boundUnverifiedRow: [], unbound: [], mismatched: [], omittedDeclared: [], missingUndeclared: [], unlisted: [] }
  const verdict = (category: VerifyCategory, problems: string[], seal: BundleVerdict['seal'] = 'not-sealed'): BundleVerdict =>
    ({ exitCode: VERIFY_EXIT[category], category, problems, seal, attachments })
  try { return verify(dir, opts, attachments, verdict) }
  catch (e) {
    // Python's malformed events.jsonl line exits 1 with its message.
    if (e instanceof BundleMalformed) return verdict('failed', [e.message])
    throw e
  }
}

function verify(dir: string, opts: BundleVerifyOptions, attachments: BundleVerdict['attachments'],
  verdict: (c: VerifyCategory, p: string[], s?: BundleVerdict['seal']) => BundleVerdict): BundleVerdict {
  const manifestPath = path.join(dir, 'manifest.json'), eventsPath = path.join(dir, 'events.jsonl')
  if (!fs.existsSync(manifestPath)) return verdict('malformed', ['manifest.json missing'])
  if (!fs.existsSync(eventsPath)) return verdict('malformed', ['events.jsonl missing'])
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { return verdict('malformed', ['manifest.json unreadable']) }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return verdict('malformed', ['manifest.json unreadable'])
  try {
    const declared = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8').split(/\s+/)[0]
    if (!declared) throw new Error('empty')
    if (declared !== sha256Hex(fs.readFileSync(manifestPath))) return verdict('failed', ['manifest checksum mismatch'])
  } catch { return verdict('failed', ['manifest checksum missing or malformed']) }

  // ── Version: refuse what this verifier does not understand ────────────────
  const version = manifest.bundleVersion
  if (!isInt(version)) return verdict('malformed', ['bundleVersion missing or not an integer'])
  if (version > BUNDLE_VERSION) return verdict('malformed', [`UNSUPPORTED: bundle version ${version} is newer than this verifier understands (up to ${BUNDLE_VERSION}); nothing was verified`])
  const v4 = version >= 4
  let sealId: string | null = null
  if (v4) {
    const unknown = Object.keys(manifest).filter((k) => !V4_MANIFEST_KEYS.has(k)).sort()
    if (unknown.length) return verdict('malformed', [`UNSUPPORTED: manifest field(s) this verifier does not understand: ${unknown.join(', ')}; nothing was verified`])
    const seal = manifest.seal as Record<string, unknown> | undefined
    if (!seal || typeof seal !== 'object' || !(typeof seal.exportId === 'string' || seal.exportId === null)) return verdict('malformed', ['v4 manifest has no valid seal block'])
    sealId = seal.exportId as string | null
    const om = manifest.omittedAttachments
    if (!Array.isArray(om) || om.some((o) => !o || typeof o.path !== 'string' || typeof o.reason !== 'string')) return verdict('malformed', ['v4 manifest has no valid omittedAttachments list'])
  }

  // ── Evidence kind and boundary declarations (unchanged since v3) ──────────
  const evidence = (manifest.evidence ?? {}) as Record<string, unknown>
  const kind = evidence.kind ?? 'complete-chain'
  if (kind !== 'complete-chain' && kind !== 'projection') return verdict('failed', ['unknown evidence kind'])
  const projection = kind === 'projection'
  const transformedList = evidence.transformedEventIds ?? []
  if (!Array.isArray(transformedList) || transformedList.some((v) => typeof v !== 'string')
    || new Set(transformedList).size !== transformedList.length || (!projection && transformedList.length)) {
    return verdict('failed', ['invalid transformed event identities'])
  }
  const transformed = new Set(transformedList as string[])
  const tiers = (manifest.tiers ?? {}) as Record<string, unknown>
  if (projection && (['chained', 'logged'] as const).some((t) => !isInt(tiers[t]) || (tiers[t] as number) < 0)) {
    return verdict('failed', ['projection requires declared per-tier counts'])
  }
  const sealCount = v4 && sealId ? 1 : 0
  const sourceChain = (evidence.sourceChain ?? { eventCount: 0 }) as Record<string, unknown>
  if (projection && (!isInt(sourceChain.eventCount) || sourceChain.eventCount < (tiers.chained as number) - sealCount)) {
    return verdict('failed', ['invalid projection source boundary'])
  }

  // ── Locate this export's seal: the last row, naming the manifest's id ─────
  let sealLine: { offset: number; row: Row } | null = null
  let lastLine: { offset: number; text: string } | null = null
  for (const l of lines(eventsPath)) lastLine = l
  if (v4 && sealId && lastLine) {
    const row = parseLine('events.jsonl', 0, lastLine.text)
    const d = parsedData(row) as Record<string, unknown> | null
    if (row.agent_type === 'system' && d && typeof d === 'object' && d.subtype === SEAL_SUBTYPE && d.exportId === sealId) sealLine = { offset: lastLine.offset, row }
  }

  // ── Walk the chained tier ─────────────────────────────────────────────────
  const operators = loadOperators(dir)
  const seen = new Set<string>()
  let walked = 0, expectedPrev: string | null = null, lastHash: string | null = null
  /** hash of the row the seal follows in events.jsonl */
  let hashBeforeSeal: string | null = null
  let unsigned = 0, noPubKey = 0, anySignature = false, firstUnsigned: string | null = null
  const verifiedRows: Array<{ row: Row; data: unknown }> = []
  const unverifiedRows: Array<{ row: Row; data: unknown }> = []
  let lineNo = 0
  for (const l of lines(eventsPath)) {
    lineNo++
    const row = parseLine('events.jsonl', lineNo, l.text)
    walked++
    const rid = row.id
    if (typeof rid !== 'string' || seen.has(rid)) return verdict('failed', [`missing or duplicate event identity: ${String(rid)}`])
    seen.add(rid)
    const isSeal = sealLine !== null && l.offset === sealLine.offset
    if (isSeal) hashBeforeSeal = lastHash
    // The seal is exempt from linking to the row before it: rows recorded
    // between the export boundary and the seal are not in the bundle. What it
    // follows is checked against its own `events` commitment instead.
    if (!projection && !isSeal && row.prev_hash !== expectedPrev) {
      return verdict('failed', [`CHAIN BROKEN at event ${rid}: prev_hash mismatch`])
    }
    const stored = row.hash
    if (!stored) return verdict('failed', [`CHAIN BROKEN at event ${rid}: row has no stored hash`])
    if (row.signature) anySignature = true
    const data = parsedData(row)
    if (transformed.has(rid)) {
      unverifiedRows.push({ row, data })
      expectedPrev = stored as string; lastHash = stored as string
      continue
    }
    const canonical = chainedRowCanonical(row as Parameters<typeof chainedRowCanonical>[0], data)
    if (sha256Hex(canonical) !== stored) return verdict('failed', [`CHAIN BROKEN at event ${rid}: hash mismatch`])
    if (row.signature) {
      const pub = operators.get(String(row.operator_id ?? ''))
      if (!pub) noPubKey++
      // The exporter's self-check is about what it wrote, not the keys: the
      // rows were signed by this app, and a recipient checks them anyway.
      else if (!opts.selfCheck && !verifyEventSignature(canonical, String(row.signature), pub)) return verdict('failed', [`SIGNATURE INVALID at event ${rid} (operator=${String(row.operator_id)})`])
    } else {
      unsigned++
      firstUnsigned ??= rid
    }
    verifiedRows.push({ row, data })
    expectedPrev = stored as string; lastHash = stored as string
  }
  // The delivered chain the manifest's chainHead describes: everything before
  // this export's seal.
  const beforeSeal = sealLine ? walked - 1 : walked
  const headLast = sealLine ? hashBeforeSeal : lastHash

  const problems: string[] = []
  let failed = false, sealFailed = false, attachmentFailed = false
  const fail = (m: string): void => { failed = true; problems.push(m) }
  const sealFail = (m: string): void => { sealFailed = true; problems.push(`SEAL MISMATCH: ${m}`) }

  const chainHead = (manifest.chainHead ?? {}) as Record<string, unknown>
  if (!projection && headLast && chainHead.hash) {
    if (sha256Hex(headLast + String(beforeSeal)) !== chainHead.hash) fail('manifest.chainHead does not match the recomputed head')
  }
  if (tiers.chained !== undefined && tiers.chained !== null && tiers.chained !== walked) return verdict('failed', ['chained row count differs from manifest'])
  if (!projection && chainHead.eventCount !== undefined && chainHead.eventCount !== null && chainHead.eventCount !== beforeSeal) {
    return verdict('failed', ['CHAIN BROKEN: chain-head event count differs from delivered chain'])
  }

  // ── Logged tier ───────────────────────────────────────────────────────────
  const loggedPath = path.join(dir, 'events_logged.jsonl')
  let loggedRows: number | null = null
  const loggedList: Array<{ row: Row; data: unknown }> = []
  if (fs.existsSync(loggedPath)) {
    loggedRows = 0
    let n = 0
    try {
      for (const l of lines(loggedPath)) {
        const row = parseLine('events_logged.jsonl', ++n, l.text)
        const rid = row.id
        if (typeof rid !== 'string' || seen.has(rid)) return verdict('failed', [`missing or duplicate event identity: ${String(rid)}`])
        seen.add(rid)
        loggedList.push({ row, data: parsedData(row) })
        loggedRows++
      }
    } catch (e) { return verdict('failed', [`logged evidence unreadable: ${(e as Error).message}`]) }
  }
  if (projection && (loggedRows ?? 0) !== tiers.logged) return verdict('failed', ['logged row count differs from manifest'])
  for (const id of transformed) if (!seen.has(id)) return verdict('failed', ['transformed event identity is not delivered'])

  // ── Manifest file digests ─────────────────────────────────────────────────
  const fileEntries = Array.isArray(manifest.files) ? manifest.files as Array<Record<string, unknown>> : []
  if (projection) {
    const covered = new Set(fileEntries.filter((e) => e.sha256).map((e) => e.path))
    const required = ['events.jsonl', ...(fs.existsSync(loggedPath) ? ['events_logged.jsonl'] : [])]
    if (required.some((p) => !covered.has(p))) return verdict('failed', ['projection event files are not covered by manifest digests'])
  }
  if (v4) {
    const paths = fileEntries.map((e) => e.path)
    if (fileEntries.some((e) => typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !isInt(e.bytes)) || new Set(paths).size !== paths.length) {
      return verdict('malformed', ['v4 manifest file list is malformed (each path once, with sha256 and bytes)'])
    }
  }
  const SELF = new Set(['manifest.json', 'manifest.sha256', 'manifest.hmac', 'redlog-verify.py', 'verify.sh', 'verify.cmd'])
  const actual = new Map<string, string>()
  const filesBad: string[] = [], filesMissing: string[] = []
  const listed = new Set<string>()
  for (const entry of fileEntries) {
    const rel = entry.path, want = entry.sha256
    if (typeof rel === 'string') listed.add(rel)
    if (typeof rel !== 'string' || !rel || !want || SELF.has(rel)) continue
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) { filesMissing.push(rel); continue }
    const got = opts.selfCheck ? String(want) : hashFile(file).sha256
    actual.set(rel, got)
    if (got !== want) filesBad.push(rel)
  }

  // ── Seal ──────────────────────────────────────────────────────────────────
  let sealState: BundleVerdict['seal'] = 'not-sealed'
  let sealOk = false
  if (v4 && sealId) {
    if (!sealLine) sealFail(`the manifest names seal ${sealId}, but the last row of events.jsonl is not it`)
    else {
      const d = parsedData(sealLine.row) as Record<string, unknown>
      const unknown = Object.keys(d).filter((k) => !SEAL_DATA_KEYS.has(k))
      const ev = (d.events && typeof d.events === 'object' && !Array.isArray(d.events) ? d.events : {}) as Record<string, unknown>
      const unknownEv = Object.keys(ev).filter((k) => !SEAL_EVENTS_KEYS.has(k))
      if (d.sealVersion !== SEAL_VERSION || unknown.length || unknownEv.length) {
        return verdict('malformed', [`UNSUPPORTED: seal version ${String(d.sealVersion)}${unknown.length || unknownEv.length ? ` with field(s) ${[...unknown, ...unknownEv].join(', ')}` : ''} is not one this verifier understands; the seal was not checked`])
      }
      if (transformed.has(String(sealLine.row.id))) sealFail('the seal row is declared transformed')
      if (d.bundleVersion !== version) sealFail('bundle version differs from the sealed one')
      if (d.manifestSha256 !== sealedManifestDigest(manifest)) sealFail('manifest differs from the one the export sealed')
      const prefix = hashFile(eventsPath, sealLine.offset)
      if (ev.count !== beforeSeal || ev.bytes !== sealLine.offset || ev.sha256 !== prefix.sha256 || (ev.headHash ?? null) !== (headLast ?? null)) {
        sealFail('events.jsonl rows before the seal differ from the ones it sealed')
      }
      sealOk = !sealFailed
    }
    sealState = sealOk ? 'sealed' : 'mismatch'
  }

  // ── Authentication ────────────────────────────────────────────────────────
  const signingInUse = anySignature || [...operators.values()].some(Boolean)
  const auth = authenticationVerdict({ signingInUse, unsigned, noPubKey, hashOnly: opts.hashOnly })
  if (auth.state === 'failed') for (const r of auth.reasons) fail(`AUTHENTICATION FAILED: ${r}${firstUnsigned && r.includes('no signature') ? `; first: ${firstUnsigned}` : ''}`)
  if (sealState === 'not-sealed') {
    // Every bundle of version 4 or later is written with a seal, so one
    // without it has lost it. Earlier versions could not have one.
    if (v4) sealFail(`a version ${version} bundle carries no export seal`)
    else if (opts.requireSeal) sealFail('the bundle is not sealed and --require-seal was given')
  }

  // ── Logged-tier digest ────────────────────────────────────────────────────
  const declaredDigest = tiers.loggedDigest as { count?: unknown; sha256?: unknown } | undefined
  if (declaredDigest && isInt(declaredDigest.count) && typeof declaredDigest.sha256 === 'string' && loggedRows !== null && !opts.selfCheck
    && loggedRows === declaredDigest.count && !loggedList.some(({ row }) => transformed.has(String(row.id)))) {
    const h = crypto.createHash('sha256')
    for (const { row } of loggedList) { h.update(canonicalStringify(row)); h.update('\n') }
    if (h.digest('hex') !== declaredDigest.sha256) fail('logged tier differs from its recorded digest')
  }

  // ── Attachments against the digests their events recorded ────────────────
  const refsByPath = new Map<string, Array<AttachmentRef & { verified: boolean }>>()
  const addRefs = (rows: Array<{ row: Row; data: unknown }>, verified: boolean): void => {
    for (const { row, data } of rows) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      for (const ref of attachmentRefs(String(row.agent_type ?? ''), data as Record<string, unknown>)) {
        const list = refsByPath.get(ref.path) ?? []
        list.push({ ...ref, verified: verified || sealOk })
        refsByPath.set(ref.path, list)
      }
    }
  }
  addRefs(verifiedRows, true)
  addRefs(unverifiedRows, false)
  addRefs(loggedList, false)
  const declaredOmissions = new Map<string, string>()
  if (v4) for (const o of manifest.omittedAttachments as Array<{ path: string; reason: string }>) declaredOmissions.set(o.path, o.reason)
  const fileMismatchPaths = new Set<string>()
  for (const [rel, refs] of [...refsByPath].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const reason = declaredOmissions.get(rel)
      if (reason !== undefined) attachments.omittedDeclared.push({ path: rel, reason })
      else {
        attachments.missingUndeclared.push(rel)
        // Listed by the manifest and gone is removal after export in any
        // version. Unlisted and undeclared is only knowable from v4, which
        // declares every omission; before that it was never written down.
        if (listed.has(rel) || v4) {
          attachmentFailed = true
          problems.push(`ATTACHMENT MISSING: ${rel} is referenced by an event and absent${listed.has(rel) ? ' although the manifest lists it' : ', and the export did not declare leaving it out'}`)
        }
        if (listed.has(rel)) fileMismatchPaths.add(rel)
      }
      continue
    }
    let ok = true
    for (const ref of refs) {
      let got: string
      if (ref.prefix) {
        const h = hashFile(file, ref.bytes ?? 0)
        got = h.bytes === ref.bytes ? h.sha256 : ''
      } else got = actual.get(rel) ?? hashFile(file).sha256
      if (got !== ref.sha256) ok = false
    }
    if (!ok) { attachments.mismatched.push(rel); fileMismatchPaths.add(rel) }
    else if (refs.some((r) => r.verified)) attachments.bound.push(rel)
    else attachments.boundUnverifiedRow.push(rel)
  }
  for (const rel of [...listed].sort()) {
    if (ATTACHMENT_DIRS.some((d) => rel.startsWith(d)) && !refsByPath.has(rel)) attachments.unbound.push(rel)
  }
  for (const d of ATTACHMENT_DIRS) {
    const abs = path.join(dir, d)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs).sort()) {
      const rel = d + name
      if (!listed.has(rel) && !refsByPath.has(rel)) attachments.unlisted.push(rel)
    }
  }
  for (const rel of attachments.mismatched) problems.push(`ATTACHMENT MISMATCH: ${rel} differs from the sha256 its event recorded`)
  if (attachments.mismatched.length) attachmentFailed = true
  for (const rel of [...filesBad, ...filesMissing]) {
    if (fileMismatchPaths.has(rel)) continue
    fail(`manifest file ${filesMissing.includes(rel) ? 'missing' : 'sha256 differs'}: ${rel}`)
  }

  const category: VerifyCategory = failed ? 'failed' : attachmentFailed ? 'attachmentMismatch' : sealFailed ? 'sealMismatch'
    : auth.state !== 'verified' && !opts.hashOnly ? 'notAuthenticated' : 'verified'
  return verdict(category, problems, sealState)
}

function loadOperators(dir: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'operators.json'), 'utf8')) as Array<Record<string, unknown>>
    for (const r of rows) if ('id' in r) out.set(String(r.id), typeof r.signerPubKey === 'string' && r.signerPubKey ? r.signerPubKey : null)
  } catch { /* no operators: nothing to check signatures against */ }
  return out
}
