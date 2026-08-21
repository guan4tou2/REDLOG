import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getProjectDir } from './db/index'

const INLINE_THRESHOLD = 4096

export interface BodyRef {
  sha256: string
  size: number
  file: string
  encoding: 'text' | 'base64'
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

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, rawBytes)
  }

  return { sha256, size: rawBytes.length, file: filename, encoding: body.encoding }
}

export function readBody(ref: BodyRef): string | null {
  try {
    const dir = bodiesDir()
    const filePath = path.join(dir, ref.file)
    if (!filePath.startsWith(dir)) return null
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath)
    if (ref.encoding === 'base64') {
      return raw.toString('base64')
    }
    return raw.toString('utf-8')
  } catch {
    return null
  }
}

export function shouldExternalize(body: { data: string } | undefined): boolean {
  if (!body || !body.data) return false
  return body.data.length > INLINE_THRESHOLD
}

export function extractBodyToSidecar(
  data: Record<string, unknown>,
  field: 'request_body' | 'response_body' | 'ws_body' | 'tcp_body'
): void {
  const body = data[field] as {
    data: string
    encoding: 'text' | 'base64'
    size: number
    sha256: string
    truncated?: boolean
    content_type?: string
  } | undefined

  if (!body || !shouldExternalize(body)) return

  const ref = storeBody(body)
  if (!ref) return

  const refField = field === 'request_body' ? 'request_body_ref'
    : field === 'response_body' ? 'response_body_ref'
    : field === 'ws_body' ? 'ws_body_ref'
    : 'tcp_body_ref'
  data[refField] = ref
  delete data[field]
}
