import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { isInsideDir } from './paths'

// io_ref sidecar (SPEC-IO-SIDECAR.md). Full captured HTTP request/response
// bodies (and any future large capture payload) live here as content-addressed
// files; only their sha256 enters the hash chain. This is the same
// reference-not-bytes model the .cast store already uses for terminal stdout
// (see cast-slice.ts) — generalized to arbitrary bodies.
//
// Invariant: bytes never enter the chain, only their digest. A body is written
// once per digest (dedup) to `<projectDir>/io/<sha256>.bin`; the event carries
// `{ ref, len, sha256, ... }`. Reads are range-capable (mirrors readCastRange)
// and path-validated to stay inside `<projectDir>/io/`.

/** Hard ceiling on a single range read, matching the .cast slice cap so a
 *  forged `len` can't ask the server to buffer an unbounded slice. */
export const MAX_IO_READ_BYTES = 8 * 1024 * 1024

/** A sidecar ref is always a lowercase sha256 hex digest — its own filename
 *  stem. Validating the shape is the first (and strongest) traversal guard:
 *  a value that is not 64 hex chars can never resolve to a body we wrote. */
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface IoRef {
  ref: string       // sidecar filename stem === sha256
  len: number       // full byte length of the stored body
  sha256: string    // digest chained in the event (=== ref)
}

/** The sidecar directory for a project — peer of `casts/`, `screenshots/`. */
export function ioDir(projectDir: string): string {
  return path.join(projectDir, 'io')
}

// A warm (compressed) body is `<sha>.bin.gz`. gzip, not zstd: zstd is not in the
// Node stdlib on every supported ABI, and gzip still gets ~5-10× on the
// JSON/HTML/timing text these bodies hold (SPEC-SCOPE-AWARE-LIFECYCLE.md warm
// stage). The ORIGINAL sha256 stays the filename stem, so verify decompresses
// and re-hashes against the attested digest — compression is fully reversible.
const RAW_EXT = '.bin'

/** Resolve a ref to its canonical (uncompressed) on-disk path iff it is a
 *  well-formed sha256 that resolves inside the project's io/ dir. Returns null
 *  for anything else — the path-traversal guard shared by read and verify.
 *  Note: the file may actually be stored compressed (`.bin.gz`); use
 *  `resolveExisting` when you need the real file. */
export function resolveRef(projectDir: string, ref: string): string | null {
  if (typeof ref !== 'string' || !SHA256_HEX.test(ref)) return null
  const dir = ioDir(projectDir)
  const resolved = path.resolve(dir, `${ref}${RAW_EXT}`)
  if (!isInsideDir(dir, resolved)) return null   // defense in depth
  return resolved
}

/** The actual on-disk file for a ref — raw `.bin` or warm `.bin.gz` — and
 *  whether it is compressed. Null if the ref is malformed or no file exists
 *  (pruned). Raw is preferred when both exist (a compress that hasn't cleaned
 *  up yet). */
export function resolveExisting(projectDir: string, ref: string): { file: string; compressed: boolean } | null {
  const raw = resolveRef(projectDir, ref)
  if (!raw) return null
  if (fs.existsSync(raw)) return { file: raw, compressed: false }
  const gz = raw + '.gz'   // <sha>.bin.gz
  if (fs.existsSync(gz)) return { file: gz, compressed: true }
  return null
}

/** Write a body to the sidecar, content-addressed and deduped by digest.
 *  Identical bodies across events collapse to one file. Returns the ref the
 *  caller stamps onto the event before it is chained. */
export function putBody(projectDir: string, bytes: Buffer): IoRef {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const dir = ioDir(projectDir)
  const file = path.join(dir, `${sha256}.bin`)
  // Dedup: a digest is a proof the content matches, so an existing file is the
  // same bytes — never rewrite it (keeps the store append-only + cheap). A body
  // already compressed to warm (`.bin.gz`) counts as present too.
  if (!fs.existsSync(file) && !fs.existsSync(file + '.gz')) {
    fs.mkdirSync(dir, { recursive: true })
    // Write to a temp name then rename so a concurrent reader never sees a
    // half-written body under its final digest name.
    const tmp = path.join(dir, `.${sha256}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, bytes)
    try {
      fs.renameSync(tmp, file)
    } catch (e) {
      // Lost a rename race (another writer landed the same digest first) — the
      // existing file is byte-identical by construction, so just drop the temp.
      try { fs.unlinkSync(tmp) } catch { /* already gone */ }
      if (!fs.existsSync(file)) throw e
    }
  }
  return { ref: sha256, len: bytes.length, sha256 }
}

/** Read a stored body, optionally a byte range `[off, off+len)`. Returns null
 *  when the ref is malformed, the body is absent (pruned by retention), or the
 *  range is out of bounds — callers distinguish pruned-vs-tampered by checking
 *  the ref shape separately. Range reads are capped at MAX_IO_READ_BYTES. */
export function readBody(projectDir: string, ref: string, off?: number, len?: number): Buffer | null {
  const found = resolveExisting(projectDir, ref)
  if (!found) return null   // pruned / never written / malformed ref

  // Warm (compressed) body: decompress whole, then slice in memory. Warm bodies
  // are the older, less-hot ones, so paying a full gunzip on read is acceptable;
  // gzip has no random access anyway.
  if (found.compressed) {
    let whole: Buffer
    try { whole = zlib.gunzipSync(fs.readFileSync(found.file)) } catch { return null }
    return sliceBuffer(whole, off, len)
  }

  let stat: fs.Stats
  try { stat = fs.statSync(found.file) } catch { return null }

  // Whole-body read.
  if (off === undefined && len === undefined) {
    if (stat.size > MAX_IO_READ_BYTES) {
      // Never buffer an oversized body whole; the caller must page it.
      return null
    }
    try { return fs.readFileSync(found.file) } catch { return null }
  }

  // Range read (mirrors readCastRange guards). Streamed from disk for raw bodies.
  const start = off ?? 0
  const wantLen = len ?? (stat.size - start)
  if (!Number.isFinite(start) || !Number.isFinite(wantLen) || start < 0 || wantLen <= 0) return null
  if (wantLen > MAX_IO_READ_BYTES) return null
  if (start >= stat.size) return null
  const end = Math.min(start + wantLen, stat.size)
  const buf = Buffer.alloc(end - start)
  let fd: number
  try { fd = fs.openSync(found.file, 'r') } catch { return null }
  try {
    const read = fs.readSync(fd, buf, 0, end - start, start)
    return read === buf.length ? buf : buf.subarray(0, read)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** Apply the same range/whole-with-cap semantics as the raw read path to an
 *  already-in-memory buffer (used after decompressing a warm body). */
function sliceBuffer(whole: Buffer, off?: number, len?: number): Buffer | null {
  if (off === undefined && len === undefined) {
    return whole.length > MAX_IO_READ_BYTES ? null : whole
  }
  const start = off ?? 0
  const wantLen = len ?? (whole.length - start)
  if (!Number.isFinite(start) || !Number.isFinite(wantLen) || start < 0 || wantLen <= 0) return null
  if (wantLen > MAX_IO_READ_BYTES) return null
  if (start >= whole.length) return null
  return whole.subarray(start, Math.min(start + wantLen, whole.length))
}

/** Warm stage (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C): compress a raw body in
 *  place to `<sha>.bin.gz`, keeping the ORIGINAL sha256 as the stem so verify
 *  still re-hashes to the attested digest. Returns true if it compressed (or was
 *  already warm), false if the ref is malformed or the body is gone. Atomic:
 *  writes a temp then renames, and only unlinks the raw once the gz is in place. */
export function compressBody(projectDir: string, ref: string): boolean {
  const raw = resolveRef(projectDir, ref)
  if (!raw) return false
  const gz = raw + '.gz'
  if (fs.existsSync(gz) && !fs.existsSync(raw)) return true   // already warm
  if (!fs.existsSync(raw)) return false
  let compressed: Buffer
  try { compressed = zlib.gzipSync(fs.readFileSync(raw)) } catch { return false }
  const tmp = `${gz}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, compressed)
    fs.renameSync(tmp, gz)
    fs.unlinkSync(raw)   // reclaim the raw bytes only after the gz landed
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    return false
  }
}

/** Total on-disk size of the io/ store (raw + warm), for the size trigger. */
export function ioStoreSize(projectDir: string): number {
  const dir = ioDir(projectDir)
  let total = 0
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    if (!n.endsWith('.bin') && !n.endsWith('.bin.gz')) continue
    try { total += fs.statSync(path.join(dir, n)).size } catch { /* raced away */ }
  }
  return total
}

// The event fields the mitmproxy addon posts a full body on, and the `io.*`
// slot each maps to. The addon only sends `*_body_full` when the inline preview
// truncated (body > REDLOG_MAX_BODY), so a small body keeps its complete
// preview and never sidecars — matching the "purely additive" migration.
interface IoBodyField {
  fullField: string      // full body text posted by the addon (utf8)
  ctField: string        // content-type carried alongside
  truncField: string     // true if capture hit REDLOG_MAX_IO
  slot: 'request' | 'response'
}
const IO_BODY_FIELDS: IoBodyField[] = [
  { fullField: 'request_body_full', ctField: 'request_body_ct', truncField: 'request_body_full_truncated', slot: 'request' },
  { fullField: 'response_body_full', ctField: 'response_body_ct', truncField: 'response_body_full_truncated', slot: 'response' },
]

/** Server-side (option B, SPEC-IO-SIDECAR.md §Capture path): move any posted
 *  full-body field into the sidecar and replace it with an `io.<slot>` ref,
 *  BEFORE the event is chained — so the chain closes over the sha256, never the
 *  bytes. Mutates `data` in place; the short `*_preview` fields are untouched.
 *  A no-op for events that carry no full-body field (all historical + small
 *  bodies), so it is safe to call on every event. */
export function stampIoRefs(data: Record<string, unknown>, projectDir: string): void {
  for (const f of IO_BODY_FIELDS) {
    const full = data[f.fullField]
    // Always strip the raw full-body field, even on the paths below that skip
    // sidecaring — it must never reach the chain as inline bytes.
    if (typeof full !== 'string' || full.length === 0) {
      delete data[f.fullField]; delete data[f.ctField]; delete data[f.truncField]
      continue
    }
    const { ref, len, sha256 } = putBody(projectDir, Buffer.from(full, 'utf8'))
    const io = (data.io && typeof data.io === 'object') ? (data.io as Record<string, unknown>) : {}
    const ref_: Record<string, unknown> = { ref, len, sha256, truncated: data[f.truncField] === true }
    if (typeof data[f.ctField] === 'string' && data[f.ctField]) ref_.ct = data[f.ctField]
    io[f.slot] = ref_
    data.io = io
    delete data[f.fullField]; delete data[f.ctField]; delete data[f.truncField]
  }
}

/** True iff the ref is well-formed and its stored bytes hash to the ref. A warm
 *  (compressed) body is decompressed first, so a compressed body still verifies
 *  against its ORIGINAL digest (SPEC-SCOPE-AWARE-LIFECYCLE.md A4). A mismatch is
 *  tampering; an absent file is pruning (caller checks existence separately). */
export function verifyBody(projectDir: string, ref: string): boolean {
  const found = resolveExisting(projectDir, ref)
  if (!found) return false
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(found.file)
    if (found.compressed) bytes = zlib.gunzipSync(bytes)
  } catch { return false }
  return crypto.createHash('sha256').update(bytes).digest('hex') === ref
}
