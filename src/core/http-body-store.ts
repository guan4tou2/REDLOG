import fs from 'fs'
import path from 'path'
import { isInsideDir } from './paths'
import crypto from 'crypto'
import { getProjectDir } from './db/index'

const INLINE_THRESHOLD = 4096

/** Every field that can hold a reference into the body store.
 *
 *  One list, because the places that must agree about it are not near each
 *  other: the search index, the retention sweep (a file nothing pins is
 *  evicted), the export plan and the attachment manifest. A ref field known to
 *  the writer and not to the sweep is a body deleted out from under its event;
 *  known to the sweep and not to the export is a body missing from the bundle.
 *  Spec 052 added the last two, when command output started taking the same
 *  path HTTP bodies already took.
 */
import { BODY_REF_FIELDS } from './content-contract'
export { BODY_REF_FIELDS } from './content-contract'

export interface BodyRef {
  sha256: string
  size: number
  file: string
  encoding: 'text' | 'base64'
  truncated?: boolean
}

let _cachedDir: string | null = null

function bodiesDir(): string {
  if (_cachedDir && fs.existsSync(_cachedDir)) return _cachedDir
  const dir = path.join(getProjectDir(), 'http-bodies')
  fs.mkdirSync(dir, { recursive: true })
  _cachedDir = dir
  return dir
}

export function resetBodiesDirCache(): void {
  _cachedDir = null
}

export function storeBody(body: {
  data: string
  encoding: 'text' | 'base64'
  size: number
  sha256: string
  truncated?: boolean
  content_type?: string
}): BodyRef | null {
  if (!body.data || body.data.length === 0) return null

  const rawBytes = body.encoding === 'base64'
    ? Buffer.from(body.data, 'base64')
    : Buffer.from(body.data, 'utf-8')

  const sha256 = crypto.createHash('sha256').update(rawBytes).digest('hex')
  const filename = `${sha256}.body`
  const filePath = path.join(bodiesDir(), filename)

  const verifyExisting = (): void => {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.size !== rawBytes.length || !fs.readFileSync(filePath).equals(rawBytes)) {
      throw new Error('Saved body does not match its content hash')
    }
  }
  if (fs.existsSync(filePath)) {
    verifyExisting()
  } else {
    // A failed write must never publish a partial file under the complete
    // content hash: later retries would mistake that file for saved evidence.
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, rawBytes, { mode: 0o600, flag: 'wx' })
      try { fs.linkSync(temporary, filePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        verifyExisting()
      }
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* absent or filesystem unavailable */ }
    }
  }

  return { sha256, size: rawBytes.length, file: filename, encoding: body.encoding }
}

function readStoredBytes(ref: BodyRef): Buffer | null {
  try {
    const dir = bodiesDir()
    const filePath = path.join(dir, ref.file)
    // isInsideDir, not startsWith: a bare prefix check passes a sibling dir that
    // shares the prefix (…/http-bodies-evil/x). ref.file comes from the renderer
    // via httpBody:read.
    if (!isInsideDir(dir, filePath)) return null
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath)
  } catch {
    return null
  }
}

function encodeRaw(raw: Buffer, ref: BodyRef): string {
  return ref.encoding === 'base64' ? raw.toString('base64') : raw.toString('utf-8')
}

export function readBody(ref: BodyRef): string | null {
  const raw = readStoredBytes(ref)
  return raw ? encodeRaw(raw, ref) : null
}

/** As `readBody`, for a delivery: null when the file is gone, and a throw when
 *  it no longer holds the bytes its ref was written for. An export must not
 *  ship other bytes under the original event's name (#461). */
export function readBodyForDelivery(ref: BodyRef): string | null {
  const raw = readStoredBytes(ref)
  if (!raw) return null
  if (crypto.createHash('sha256').update(raw).digest('hex') !== ref.sha256) throw new Error('source-unavailable')
  return encodeRaw(raw, ref)
}

export function shouldExternalize(body: { data: string } | undefined): boolean {
  if (!body || !body.data) return false
  return body.data.length > INLINE_THRESHOLD
}

/** The same sidecar treatment for a plain string field.
 *
 *  Command output is a string on the event, not the `{data, encoding, …}`
 *  envelope an HTTP body arrives in — but the problem is identical and so is
 *  the answer. Spec 052 relays every command, so `nmap -A` and `ffuf` land
 *  here routinely; keeping the body in full and referencing it beats a
 *  truncation limit that would have to be re-argued the first time someone
 *  ran a full-port scan (research.md T006).
 *
 *  The caller must have finished reading the text — loot scanning runs over
 *  `data.stdout` and would find nothing once this has removed it.
 */
export function extractTextToSidecar(
  data: Record<string, unknown>,
  field: string,
  refField: string
): void {
  const text = data[field]
  if (typeof text !== 'string' || text.length <= INLINE_THRESHOLD) return
  const ref = storeBody({
    data: text,
    encoding: 'text',
    size: Buffer.byteLength(text, 'utf-8'),
    // storeBody hashes the bytes itself; this is the field's shape, not an
    // assertion about the content.
    sha256: ''
  })
  if (!ref) return
  if (data[`${field}_truncated`] === true) ref.truncated = true
  data[refField] = ref
  delete data[field]
}

export function extractBodyToSidecar(
  data: Record<string, unknown>,
  field: 'request_body' | 'response_body' | 'ws_body' | 'tcp_body' | 'output_body'
): void {
  const body = data[field] as {
    data: string
    encoding: 'text' | 'base64'
    size: number
    sha256: string
    truncated?: boolean
    content_type?: string
  } | undefined

  if (!body || (field !== 'output_body' && !shouldExternalize(body))) return

  const ref = storeBody(body)
  if (!ref) return

  if (body.truncated) ref.truncated = true

  data[`${field}_ref`] = ref
  delete data[field]
}
