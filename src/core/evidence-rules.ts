// The verification rules an evidence bundle is judged by, in one place.
//
// Three readers apply them: the exporter (to declare what it leaves out and to
// seal what it ships), the in-app checks (the Integrity walk over the project
// database and the self-check of every bundle the app writes), and the
// standalone tools/redlog-verify.py a recipient runs. The Python file is a port
// of this module, not a second design; test/evidence-vectors.test.ts runs the
// same tampered bundles through both and requires the same verdict. A rule
// changed here and not there fails that test. docs/audit-trail.md says what the
// rules prove and what they cannot.

import crypto from 'crypto'
import { canonicalStringify } from './db/event-write'

/** v4: the export seal (system.export_sealed) and declared omissions. */
export const BUNDLE_VERSION = 4
export const SEAL_SUBTYPE = 'export_sealed'
export const SEAL_VERSION = 1

/** Exit codes shared by both verifiers. 1, 2 and 3 predate v4 and keep their
 *  meaning; 4 and 5 are new. When several apply the lowest-numbered failure
 *  among 2, 1, 4, 5 is returned, then 3. */
export const VERIFY_EXIT = {
  verified: 0,
  failed: 1,
  malformed: 2,
  notAuthenticated: 3,
  /** an attachment's bytes differ from the digest its event recorded at
   *  capture, or (v4) an attachment an event refers to is absent and the
   *  export did not declare leaving it out */
  attachmentMismatch: 4,
  /** the bundle differs from what its export sealed, or a signed v4 bundle
   *  carries no seal (and `--require-seal` on an unsealed bundle) */
  sealMismatch: 5
} as const
export type VerifyCategory = keyof typeof VERIFY_EXIT

export const ATTACHMENT_DIRS = ['screenshots/', 'casts/', 'http-bodies/', 'artifacts/', 'agent-transcripts/'] as const

/** Body-store pointers whose `sha256` names `http-bodies/<sha256>.body`.
 *  The union of content-contract's BODY_REF_FIELDS and redact-export's
 *  BODY_REF_FOR values; test/evidence-vectors.test.ts keeps all three equal. */
export const BODY_REF_KEYS = [
  'request_body_ref', 'response_body_ref', 'ws_body_ref', 'tcp_body_ref',
  'stdout_ref', 'stderr_ref', 'output_body_ref', 'output_ref'
] as const

export type AttachmentKind = 'screenshot' | 'cast' | 'httpBody' | 'artifact' | 'agentTranscript'
export interface AttachmentRef {
  /** bundle-relative path */
  path: string
  kind: AttachmentKind
  sha256: string
  /** `prefix`: the digest covers only the first `bytes` of the file (an AI
   *  transcript keeps growing after its snapshot event). Otherwise the whole
   *  file, and `bytes` is its recorded size when the event gave one. */
  bytes: number | null
  prefix: boolean
}

const HEX64 = /^[0-9a-f]{64}$/
const plainName = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
/** Last component of a path written on any platform. */
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? ''
const size = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
const hex = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v)

/** The attachment digests an event recorded when it was captured. */
export function attachmentRefs(agentType: string, data: Record<string, unknown>): AttachmentRef[] {
  const out: AttachmentRef[] = []
  const subtype = data.subtype
  if (agentType === 'screenshot' && plainName(data.filename) && hex(data.sha256)) {
    out.push({ path: `screenshots/${data.filename}`, kind: 'screenshot', sha256: data.sha256, bytes: size(data.size), prefix: false })
  }
  if (agentType === 'shell' && subtype === 'session_end') {
    const segments = Array.isArray(data.castSegments) ? data.castSegments as Array<Record<string, unknown>> : []
    if (segments.length > 0) {
      for (const s of segments) {
        const name = typeof s?.path === 'string' ? baseName(s.path) : ''
        if (plainName(name) && hex(s.sha256)) out.push({ path: `casts/${name}`, kind: 'cast', sha256: s.sha256, bytes: size(s.bytes), prefix: false })
      }
    } else if (typeof data.castPath === 'string' && hex(data.castSha256)) {
      // Recordings that predate segments: one file, one digest.
      const name = baseName(data.castPath)
      if (plainName(name)) out.push({ path: `casts/${name}`, kind: 'cast', sha256: data.castSha256, bytes: size(data.castBytes), prefix: false })
    }
  }
  if (agentType === 'file_transfer' && subtype === 'artifact_added' && typeof data.stored === 'string' && hex(data.sha256)) {
    const [dir, name, ...rest] = data.stored.split('/')
    if (dir === 'artifacts' && plainName(name) && rest.length === 0) out.push({ path: data.stored, kind: 'artifact', sha256: data.sha256, bytes: size(data.size), prefix: false })
  }
  if (agentType === 'agent' && subtype === 'transcript_snapshot' && typeof data.snapshot_path === 'string' && hex(data.cumulative_sha256)) {
    const name = baseName(data.snapshot_path), bytes = size(data.cumulative_bytes)
    if (plainName(name) && bytes !== null) out.push({ path: `agent-transcripts/${name}`, kind: 'agentTranscript', sha256: data.cumulative_sha256, bytes, prefix: true })
  }
  for (const key of BODY_REF_KEYS) {
    const ref = data[key] as Record<string, unknown> | undefined
    if (ref && typeof ref === 'object' && hex(ref.sha256)) {
      out.push({ path: `http-bodies/${ref.sha256}.body`, kind: 'httpBody', sha256: ref.sha256, bytes: size(ref.size), prefix: false })
    }
  }
  return out
}

export const sha256Hex = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex')

/** What a seal's `manifestSha256` covers: the manifest as written, without its
 *  `seal` block and without the `events.jsonl` file entry. Both are written
 *  after the seal row exists (that row is the last line of events.jsonl, and
 *  the seal commits to the lines before it separately), so they cannot be in
 *  what it commits to. Everything else the manifest says — the file list,
 *  declared omissions, tiers, evidence kind, plan, scope policy — is. */
export function sealedManifestDigest(manifest: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>
  delete copy.seal
  if (Array.isArray(copy.files)) copy.files = (copy.files as Array<{ path?: unknown }>).filter((f) => f?.path !== 'events.jsonl')
  return sha256Hex(canonicalStringify(copy))
}

/** The canonical payload a chained row's hash and signature cover. The
 *  writer builds the same object in db/event-write.ts. */
export function chainedRowCanonical(row: {
  id: unknown; timestamp: unknown; engagement_id: unknown; session_id: unknown; operator_id: unknown; agent_type: unknown
  hostname: unknown; source_ip: unknown; target_id: unknown; prev_hash: unknown; created_at: unknown; monotonic_ns: unknown; ntp_offset_ms: unknown
}, parsedData: unknown): string {
  return canonicalStringify({
    id: row.id,
    timestamp: row.timestamp,
    engagementId: row.engagement_id,
    sessionId: row.session_id,
    operatorId: row.operator_id,
    agentType: row.agent_type,
    hostname: row.hostname,
    sourceIP: row.source_ip,
    targetId: row.target_id,
    data: parsedData,
    prevHash: row.prev_hash,
    createdAt: row.created_at,
    monotonicNs: row.monotonic_ns,
    ntpOffsetMs: row.ntp_offset_ms,
    tier: 'chained'
  })
}

/** Authentication of a chain. Hashes can be recomputed by anyone, so once
 *  signing is in use (a row carries a signature, or an operator has a signer
 *  key) an unsigned row, or a signed row whose operator has no key to check it
 *  against, is a failure, not a counter. `hashOnly` accepts that explicitly
 *  and reports the chain as not authenticated instead. */
export function authenticationVerdict(c: {
  signingInUse: boolean; unsigned: number; noPubKey: number; uncheckable?: number; hashOnly?: boolean
}): { state: 'verified' | 'none' | 'failed'; reasons: string[] } {
  if (!c.signingInUse) return { state: 'none', reasons: [] }
  const reasons: string[] = []
  if (c.unsigned) reasons.push(`${c.unsigned} event(s) carry no signature although signing was in use`)
  if (c.noPubKey) reasons.push(`${c.noPubKey} signed event(s) cannot be checked: their operator has no signer public key`)
  if (c.uncheckable) reasons.push(`${c.uncheckable} signed event(s) cannot be checked: the signature library is unavailable`)
  if (reasons.length === 0) return { state: 'verified', reasons }
  return { state: c.hashOnly ? 'none' : 'failed', reasons }
}
