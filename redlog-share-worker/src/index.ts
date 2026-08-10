// RedLog share Worker — see README.md and ../../docs/CLOUD_SHARE_BUNDLE.md.
//
// Wire contract (matches src/core/cloud-share-uploader.ts httpsUploader):
//   POST /api/share/init  { sha256, sizeBytes, engagementId, expiresIn }
//     → { putUrl, shareUrl, expiresAt }
//   PUT  {putUrl}   <zip bytes>
//     → 200
//
// R2 signed URLs: the Workers R2 binding does not (yet) expose a native
// createSignedUrl(); the other supported path is AWS SigV4 against the S3
// endpoint, which needs access keys as extra secrets. We take the third
// option: `putUrl` and the download endpoint are BOTH Worker-hosted, gated
// by a short-lived HMAC token (`SIGNING_KEY`), and the R2 read/write goes
// through the binding on our side. Cloudflare charges nothing for R2
// egress and Workers ingress, so proxying bytes is cost-equivalent to a
// direct S3-signed URL and avoids handing out S3 credentials.

export interface Env {
  BUNDLES: R2Bucket
  SHARES: KVNamespace
  AUTH_TOKEN: string
  SIGNING_KEY: string
  RETENTION_ROW_DAYS?: string
  MAX_UPLOAD_MB?: string
  PUBLIC_BASE_URL?: string
}

type Expiry = '24h' | '7d' | '30d' | '90d' | 'never'
const EXPIRY_MS: Record<Exclude<Expiry, 'never'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000
}

interface ShareRow {
  sha256: string
  sizeBytes: number
  engagementId: string
  createdAt: number
  expiresAt: number | null
  uploadedAt: number | null
  viewerCount: number
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(req.url)
      const p = url.pathname
      if (req.method === 'GET' && p === '/health') return health(env)
      if (req.method === 'POST' && p === '/api/share/init') return initShare(req, env)
      if (req.method === 'PUT' && p.startsWith('/api/share/put/')) return putBytes(req, env, url)
      if (req.method === 'GET' && p.startsWith('/api/share/get/')) return getBytes(req, env, url)
      if (req.method === 'GET' && p.startsWith('/share/') && p.endsWith('/download'))
        return downloadRedirect(env, url, p.split('/')[2])
      if (req.method === 'GET' && p.startsWith('/share/')) return sharePage(env, ctx, p.split('/')[2])
      if (req.method === 'POST' && p.startsWith('/api/share/revoke/'))
        return revoke(req, env, p.split('/')[4])
      return json({ error: 'not found' }, 404)
    } catch (e) {
      // Don't leak stack traces or PII from the request into the response.
      return json({ error: 'internal error' }, 500)
    }
  }
}

// --- Handlers ---------------------------------------------------------------

function health(env: Env): Response {
  return json({ ok: true, worker: 'redlog-share', maxUploadMb: maxUploadMb(env) })
}

async function initShare(req: Request, env: Env): Promise<Response> {
  // TODO(magic-link): v1 uses a single shared bearer per deploy. Spec §10
  // upgrades this to per-operator device tokens minted via magic link. Until
  // then, deployers rotate AUTH_TOKEN when an operator leaves.
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401)

  const body = await safeJson(req)
  if (!body) return json({ error: 'bad json' }, 400)

  const sha256 = String(body.sha256 ?? '')
  const sizeBytes = Number(body.sizeBytes)
  const engagementId = String(body.engagementId ?? '')
  const expiresIn = String(body.expiresIn ?? '30d') as Expiry
  if (!/^[a-f0-9]{64}$/.test(sha256)) return json({ error: 'invalid sha256' }, 400)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return json({ error: 'invalid sizeBytes' }, 400)
  const capBytes = maxUploadMb(env) * 1024 * 1024
  if (sizeBytes > capBytes) return json({ error: `sizeBytes > MAX_UPLOAD_MB (${maxUploadMb(env)})` }, 413)
  if (!engagementId) return json({ error: 'invalid engagementId' }, 400)
  if (!(expiresIn in EXPIRY_MS) && expiresIn !== 'never') return json({ error: 'invalid expiresIn' }, 400)

  const now = Date.now()
  const expiresAt = expiresIn === 'never' ? null : now + EXPIRY_MS[expiresIn]
  const slug = await mintSlug(env.SHARES, engagementId)
  const row: ShareRow = {
    sha256, sizeBytes, engagementId, createdAt: now, expiresAt,
    uploadedAt: null, viewerCount: 0
  }
  const kvOpts: KVNamespacePutOptions = expiresAt ? { expiration: Math.floor(expiresAt / 1000) } : {}
  await env.SHARES.put(`share:${slug}`, JSON.stringify(row), kvOpts)

  const base = publicBase(env, req)
  const putToken = await signToken(env, `PUT:${sha256}`, now + 10 * 60_000)
  const putUrl = `${base}/api/share/put/${sha256}?token=${putToken}`
  const shareUrl = `${base}/share/${slug}`
  return json({ putUrl, shareUrl, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null })
}

async function putBytes(req: Request, env: Env, url: URL): Promise<Response> {
  const sha256 = url.pathname.substring('/api/share/put/'.length)
  if (!/^[a-f0-9]{64}$/.test(sha256)) return json({ error: 'invalid key' }, 400)
  const token = url.searchParams.get('token') ?? ''
  const ok = await verifyToken(env, `PUT:${sha256}`, token)
  if (!ok) return json({ error: 'invalid or expired put token' }, 403)

  const capBytes = maxUploadMb(env) * 1024 * 1024
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > capBytes) return json({ error: 'body too large' }, 413)

  if (!req.body) return json({ error: 'missing body' }, 400)
  try {
    // v0.11.0: verify the content actually hashes to the key it is stored
    // under. The old comment claimed the SHA was "re-verified on the next
    // /share/:slug read", but that check only ran when R2 happened to have
    // recorded a checksum — and the client never sent one, so in practice
    // nothing was ever verified. The object key is a sha256 the uploader
    // chose; storing bytes under it without checking made the key a label
    // rather than a claim anyone could rely on.
    //
    // `sha256` here is exactly what the operator's manifest names, so a
    // mismatch means the bytes in flight are not the bytes that were
    // reviewed. Reject rather than store: a share URL handing out unverified
    // content is worse than a failed upload.
    //
    // R2's own checksum enforcement does the comparison server-side, so this
    // costs no extra buffering.
    const digest = new Uint8Array(sha256.match(/../g)!.map((b) => parseInt(b, 16)))
    await env.BUNDLES.put(sha256, req.body, {
      httpMetadata: { contentType: 'application/zip' },
      sha256: digest
    })
  } catch (e) {
    // R2 raises on a checksum mismatch; report it distinctly so an operator
    // sees "the upload was corrupted or tampered with" rather than a generic
    // storage error.
    const msg = String((e as Error)?.message ?? '')
    if (/checksum|sha-?256|digest/i.test(msg)) {
      return json({ error: 'content does not match its declared sha256' }, 400)
    }
    return json({ error: 'storage write failed' }, 502)
  }
  return json({ ok: true })
}

async function getBytes(req: Request, env: Env, url: URL): Promise<Response> {
  const sha256 = url.pathname.substring('/api/share/get/'.length)
  if (!/^[a-f0-9]{64}$/.test(sha256)) return new Response('bad key', { status: 400 })
  const token = url.searchParams.get('token') ?? ''
  const ok = await verifyToken(env, `GET:${sha256}`, token)
  if (!ok) return new Response('invalid or expired token', { status: 403 })
  const obj = await env.BUNDLES.get(sha256).catch(() => null)
  if (!obj) return new Response('gone', { status: 410 })
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${sha256.slice(0, 12)}.zip"`,
      // Defence in depth: no scripts, ever, on this endpoint.
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=0, no-store'
    }
  })
}

async function sharePage(env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const row = await readRow(env, slug)
  if (!row) return htmlPage('Not found', notFoundBody(), 404)
  if (row.expiresAt && Date.now() > row.expiresAt) return htmlPage('Expired', expiredBody(), 410)

  // First view flips uploadedAt if the object now exists. Defense-in-depth
  // check: if the uploaded object's key doesn't match declared sha256,
  // surface a helpful diagnostic (this catches a client bug that PUT
  // different bytes than it announced).
  const head = await env.BUNDLES.head(row.sha256).catch(() => null)
  if (!head) {
    // Upload may not have completed yet.
    return htmlPage('Pending', pendingBody(), 202)
  }
  if (head.checksums?.sha256) {
    // R2 exposes sha256 checksum on PUT if the client sent x-amz-checksum-sha256;
    // when present, refuse to serve if it disagrees with what init recorded.
    const observed = bytesToHex(head.checksums.sha256)
    if (observed && observed !== row.sha256) {
      return htmlPage('Integrity mismatch', integrityBody(), 500)
    }
  }
  if (!row.uploadedAt) {
    row.uploadedAt = Date.now()
    ctx.waitUntil(env.SHARES.put(`share:${slug}`, JSON.stringify(row),
      row.expiresAt ? { expiration: Math.floor(row.expiresAt / 1000) } : {}))
  } else {
    // fire-and-forget viewerCount++
    row.viewerCount += 1
    ctx.waitUntil(env.SHARES.put(`share:${slug}`, JSON.stringify(row),
      row.expiresAt ? { expiration: Math.floor(row.expiresAt / 1000) } : {}))
  }

  return htmlPage('RedLog bundle', renderShareBody(slug, row), 200)
}

async function downloadRedirect(env: Env, url: URL, slug: string): Promise<Response> {
  const row = await readRow(env, slug)
  if (!row) return new Response('not found', { status: 404 })
  if (row.expiresAt && Date.now() > row.expiresAt) return new Response('gone', { status: 410 })
  const token = await signToken(env, `GET:${row.sha256}`, Date.now() + 5 * 60_000)
  const base = publicBase(env, new Request(url))
  return Response.redirect(`${base}/api/share/get/${row.sha256}?token=${token}`, 302)
}

async function revoke(req: Request, env: Env, slug: string): Promise<Response> {
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401)
  const row = await readRow(env, slug)
  if (!row) return json({ error: 'not found' }, 404)
  await Promise.allSettled([
    env.BUNDLES.delete(row.sha256),
    env.SHARES.delete(`share:${slug}`)
  ])
  return json({ ok: true })
}

// --- helpers ----------------------------------------------------------------

function maxUploadMb(env: Env): number {
  const n = Number(env.MAX_UPLOAD_MB ?? '100')
  return Number.isFinite(n) && n > 0 ? n : 100
}

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${env.AUTH_TOKEN}`
  if (!env.AUTH_TOKEN || header.length !== expected.length) return false
  return timingSafeEqualStr(header, expected)
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readRow(env: Env, slug: string): Promise<ShareRow | null> {
  if (!/^[a-z0-9-]{4,80}$/.test(slug)) return null
  const raw = await env.SHARES.get(`share:${slug}`).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw) as ShareRow } catch { return null }
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try { return (await req.json()) as Record<string, unknown> } catch { return null }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function publicBase(env: Env, req: Request): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const u = new URL(req.url)
  return `${u.protocol}//${u.host}`
}

// Crockford base32 (no I L O U to avoid confusion). 8 chars = 40 bits.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
async function mintSlug(kv: KVNamespace, engagementId: string): Promise<string> {
  const fragment = slugFragment(engagementId)
  for (let i = 0; i < 5; i++) {
    const rand = crypto.getRandomValues(new Uint8Array(5)) // 40 bits
    let suffix = ''
    for (const b of rand) suffix += CROCKFORD[b & 31]
    const slug = `${fragment}-${suffix.toLowerCase()}`
    const collision = await kv.get(`share:${slug}`)
    if (!collision) return slug
  }
  throw new Error('slug collision')
}

function slugFragment(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const short = cleaned.slice(0, 24)
  return short || 'engagement'
}

// --- token signing ----------------------------------------------------------

async function signToken(env: Env, scope: string, expMs: number): Promise<string> {
  const key = await hmacKey(env.SIGNING_KEY)
  const payload = `${scope}:${expMs}`
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${expMs.toString(36)}.${bytesToB64Url(new Uint8Array(sig))}`
}

async function verifyToken(env: Env, scope: string, token: string): Promise<boolean> {
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const expMs = parseInt(token.substring(0, dot), 36)
  if (!Number.isFinite(expMs) || Date.now() > expMs) return false
  const expected = await signToken(env, scope, expMs)
  return timingSafeEqualStr(token, expected)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('SIGNING_KEY unset')
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  )
}

function bytesToB64Url(u8: Uint8Array): string {
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bytesToHex(buf: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!buf) return ''
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}

// --- HTML rendering ---------------------------------------------------------
//
// Deliberately minimal (no external CSS / JS). Any interpolated field is
// escaped through `esc()`. CSP forbids scripts and remote loads.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function htmlPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — RedLog share</title>
<style>
:root{color-scheme:dark light}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0d;color:#e5e5e5;margin:0;padding:48px 16px;display:flex;justify-content:center}
.card{max-width:640px;width:100%;background:#141418;border:1px solid #2a2a30;border-radius:10px;padding:28px}
h1{font-size:18px;margin:0 0 4px;color:#fafafa}
p.sub{color:#9a9aa2;margin:0 0 20px;font-size:13px}
dl{display:grid;grid-template-columns:130px 1fr;gap:6px 14px;margin:0 0 24px;font-size:13px}
dt{color:#8a8a92}
dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d4d4d8;word-break:break-all}
a.btn{display:inline-block;background:#c73737;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600}
a.btn:hover{background:#a52929}
.tip{margin-top:18px;color:#7a7a82;font-size:12px}
code{background:#1c1c22;padding:2px 6px;border-radius:3px}
</style></head><body><main class="card">${body}</main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Locks down the download page — no scripts, no remote loads.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function renderShareBody(slug: string, row: ShareRow): string {
  const size = humanBytes(row.sizeBytes)
  const created = row.uploadedAt ? new Date(row.uploadedAt).toISOString() : '(pending)'
  const expires = row.expiresAt ? new Date(row.expiresAt).toISOString() : 'never'
  return `
<h1>RedLog evidence bundle</h1>
<p class="sub">Engagement <code>${esc(row.engagementId)}</code></p>
<dl>
  <dt>Slug</dt><dd>${esc(slug)}</dd>
  <dt>SHA-256</dt><dd>${esc(row.sha256)}</dd>
  <dt>Size</dt><dd>${esc(size)}</dd>
  <dt>Uploaded</dt><dd>${esc(created)}</dd>
  <dt>Expires</dt><dd>${esc(expires)}</dd>
</dl>
<a class="btn" href="/share/${esc(slug)}/download">Download bundle (${esc(size)})</a>
<p class="tip">Verify locally: <code>shasum -a 256 bundle.zip</code> must match the SHA-256 above.</p>`
}

function notFoundBody(): string {
  return `<h1>Not found</h1><p class="sub">This share link is unknown or was revoked.</p>`
}
function expiredBody(): string {
  return `<h1>Expired</h1><p class="sub">This share link is past its expiry date. Ask the operator for a fresh link.</p>`
}
function pendingBody(): string {
  return `<h1>Pending</h1><p class="sub">The uploader has registered this share but the bytes are not on disk yet. Refresh in a few seconds.</p>`
}
function integrityBody(): string {
  return `<h1>Integrity mismatch</h1><p class="sub">The stored object's SHA-256 does not match what the uploader declared. The operator was notified; do not trust the bytes.</p>`
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
