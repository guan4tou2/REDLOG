import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { homedir } from 'os'
import { request as httpsRequest } from 'https'
import { URL, pathToFileURL } from 'url'
import type { BundleManifest, PreparedBundle } from './cloud-share'

// Uploader indirection so the same call surface talks to a real backend or a
// local file:// stub. The stub is what ships in v1 — it writes the bundle to
// a local shares/ dir and mints a fake file:// URL, so the whole flow (build
// → gate → "upload" → get URL) is end-to-end testable without a running
// backend service. Backends land later behind the same interface.

export interface UploadResult {
  ok: boolean
  shareUrl?: string
  uploadedAt?: string
  expiresAt?: string
  error?: string
  /** if the backend enforces a wire-format check and rejects, surface why */
  serverMessage?: string
}

export interface Uploader {
  /** name shown in the share dialog + emitted into audit events */
  id: string
  /** @param prepared the .zip + manifest returned by prepareCloudShareBundle */
  upload(prepared: PreparedBundle, options: UploadOptions): Promise<UploadResult>
}

export interface UploadOptions {
  /** Backend URL if the uploader talks HTTP; unused by the file:// stub. */
  endpoint?: string
  /** Short-lived operator token minted by the backend during auth. */
  bearer?: string
  /** Expiry the operator requested in the UI. Wire value the backend enforces. */
  expiresIn?: '24h' | '7d' | '30d' | '90d' | 'never'
}

// ---- Local file:// stub ----------------------------------------------------

/**
 * "Uploads" by copying the .zip into ~/.redlog/shares/<sha8>/ so the whole
 * flow runs without a backend service. Returns a file:// URL that opens the
 * folder in Finder / Explorer. Useful for local demos, tests, and air-gapped
 * engagements where "share" means "hand this bundle to another operator on
 * the same box".
 */
export const localFileUploader: Uploader = {
  id: 'file-stub',
  async upload(prepared, options): Promise<UploadResult> {
    const sharesRoot = path.join(homedir(), '.redlog', 'shares')
    // Bucket by an 8-hex-char prefix of the zip sha to keep any single
    // directory from growing unbounded. Enough entropy to avoid collision
    // across a single operator's history.
    const shortHash = prepared.manifest.zipSha256.slice(0, 8)
    const destDir = path.join(sharesRoot, shortHash)
    fs.mkdirSync(destDir, { recursive: true })
    const destZip = path.join(destDir, path.basename(prepared.zipPath))
    const destManifest = destZip + '.manifest.json'
    fs.copyFileSync(prepared.zipPath, destZip)
    const now = new Date().toISOString()
    const expiresAt = deriveExpiry(options.expiresIn ?? '30d', now)
    const finalManifest: BundleManifest = {
      ...prepared.manifest,
      upload: {
        shareUrl: pathToFileURL(destZip).href,
        uploadedAt: now,
        expiresAt: expiresAt ?? undefined
      }
    }
    fs.writeFileSync(destManifest, JSON.stringify(finalManifest, null, 2))
    // Return expiresAt only when we actually set one; 'never' shouldn't leak a
    // literal null into a string-typed field — makes it easier for callers to
    // check `if (r.expiresAt)`.
    return {
      ok: true, shareUrl: pathToFileURL(destZip).href, uploadedAt: now,
      ...(expiresAt ? { expiresAt } : {})
    }
  }
}

// ---- Real HTTPS backend ----------------------------------------------------

// Two-step upload matching spec §5:
//   POST {endpoint}/api/share/init  { sha256, sizeBytes, engagementId, expiresIn }
//     → { putUrl, shareUrl, expiresAt }
//   PUT  putUrl  <bytes>
//
// The backend must reject if sha256 of received bytes != declared sha256.
// This client re-hashes AFTER upload as an extra check for the operator.
export const httpsUploader: Uploader = {
  id: 'https',
  async upload(prepared, options): Promise<UploadResult> {
    if (!options.endpoint) return { ok: false, error: 'endpoint required for https uploader' }
    const initUrl = new URL('/api/share/init', options.endpoint).toString()
    const initBody = JSON.stringify({
      sha256: prepared.manifest.zipSha256,
      sizeBytes: prepared.manifest.zipBytes,
      engagementId: prepared.manifest.engagement.id,
      expiresIn: options.expiresIn ?? '30d'
    })
    let init: { putUrl: string; shareUrl: string; expiresAt?: string }
    try {
      init = await httpsJson(initUrl, 'POST', initBody, options.bearer) as typeof init
    } catch (e) { return { ok: false, error: `init: ${(e as Error).message}` } }
    if (!init.putUrl || !init.shareUrl) return { ok: false, error: 'init: missing putUrl / shareUrl' }

    try { await httpsPut(init.putUrl, fs.readFileSync(prepared.zipPath)) }
    catch (e) { return { ok: false, error: `put: ${(e as Error).message}` } }

    // Sanity: re-hash from disk and compare to what we told the backend to
    // expect. Catches a truncated read or a re-written file in between.
    const actual = crypto.createHash('sha256').update(fs.readFileSync(prepared.zipPath)).digest('hex')
    if (actual !== prepared.manifest.zipSha256) {
      return { ok: false, error: 'post-upload sha256 drift — bundle on disk changed between prepare and upload' }
    }
    return {
      ok: true, shareUrl: init.shareUrl,
      uploadedAt: new Date().toISOString(),
      expiresAt: init.expiresAt
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function deriveExpiry(kind: NonNullable<UploadOptions['expiresIn']>, nowIso: string): string | null {
  if (kind === 'never') return null
  const now = new Date(nowIso).getTime()
  const ms = kind === '24h' ? 86_400_000
    : kind === '7d' ? 7 * 86_400_000
      : kind === '30d' ? 30 * 86_400_000
        : 90 * 86_400_000
  return new Date(now + ms).toISOString()
}

function httpsJson(urlStr: string, method: 'POST' | 'GET', body: string | null, bearer?: string): Promise<unknown> {
  const u = new URL(urlStr)
  return new Promise((resolveP, reject) => {
    const req = httpsRequest({
      protocol: u.protocol, host: u.hostname, port: u.port, path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`))
        try { resolveP(JSON.parse(raw)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(20_000, () => req.destroy(new Error('init timeout')))
    if (body) req.write(body)
    req.end()
  })
}

function httpsPut(urlStr: string, bytes: Buffer): Promise<void> {
  const u = new URL(urlStr)
  return new Promise((resolveP, reject) => {
    const req = httpsRequest({
      protocol: u.protocol, host: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': bytes.length }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) {
          const raw = Buffer.concat(chunks).toString('utf-8').slice(0, 200)
          return reject(new Error(`PUT ${res.statusCode}: ${raw}`))
        }
        resolveP()
      })
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => req.destroy(new Error('put timeout')))
    req.write(bytes)
    req.end()
  })
}
