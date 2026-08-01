#!/usr/bin/env node
// redlog-share-worker/smoke.js — post-deploy smoke test.
//
// After you `wrangler deploy`, run this against the deployed URL to verify
// every endpoint in the two-step upload contract is wired up. It:
//   1. GET /health           — worker is up + reachable
//   2. POST /api/share/init  — auth + sha/size validation + putUrl/shareUrl mint
//   3. PUT  putUrl <bytes>   — R2 write path
//   4. GET /share/:slug      — public download page renders and finds the object
//   5. GET /share/:slug/download — 302 to a fresh R2 signed URL
//   6. POST /api/share/revoke/:slug — cleanup
//
// Every step's status + timing is printed. Exits 0 on all-green, 1 on the first
// failure. Never used in production paths — just a hand-runnable diagnostic.
//
// Usage:
//   node smoke.js https://redlog-share.<acct>.workers.dev <AUTH_TOKEN>

const crypto = require('crypto')

const [, , baseArg, tokenArg] = process.argv
if (!baseArg || !tokenArg) {
  console.error('usage: node smoke.js <worker-url> <AUTH_TOKEN>')
  process.exit(1)
}
const BASE = baseArg.replace(/\/+$/, '')
const TOKEN = tokenArg

function fmtMs(ms) { return `${ms.toFixed(0)}ms` }
function nowMs() { return Number(process.hrtime.bigint() / 1_000_000n) }

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts)
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, headers: r.headers, body }
}

async function step(name, fn) {
  const t0 = nowMs()
  try {
    const out = await fn()
    console.log(`  \x1b[32m✓\x1b[0m ${name.padEnd(38)} ${fmtMs(nowMs() - t0)}`)
    return out
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name.padEnd(38)} ${fmtMs(nowMs() - t0)}  ${e.message}`)
    throw e
  }
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`)

  // Build a small fake bundle so we don't rely on a real .zip in this repo.
  const bytes = Buffer.from(`redlog-smoke ${Date.now()}\n`.repeat(64))
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')

  let shareUrl, slug
  let putUrl

  await step('GET  /health', async () => {
    const r = await fetchJson(`${BASE}/health`)
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    if (!r.body || r.body.ok !== true) throw new Error(`body missing ok: ${JSON.stringify(r.body)}`)
  })

  await step('POST /api/share/init (unauthed → 401)', async () => {
    const r = await fetchJson(`${BASE}/api/share/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256, sizeBytes: bytes.length, engagementId: 'smoke', expiresIn: '24h' })
    })
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`)
  })

  const init = await step('POST /api/share/init (authed)', async () => {
    const r = await fetchJson(`${BASE}/api/share/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sha256, sizeBytes: bytes.length, engagementId: 'smoke', expiresIn: '24h' })
    })
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    if (!r.body.putUrl || !r.body.shareUrl) throw new Error(`missing putUrl/shareUrl: ${JSON.stringify(r.body)}`)
    return r.body
  })
  putUrl = init.putUrl
  shareUrl = init.shareUrl
  slug = shareUrl.split('/share/')[1]

  await step('PUT  <putUrl> <bytes>', async () => {
    const r = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) },
      body: bytes
    })
    if (r.status !== 200 && r.status !== 204) throw new Error(`HTTP ${r.status}`)
  })

  await step('GET  /share/:slug (download page)', async () => {
    const r = await fetch(shareUrl)
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    if (!text.toLowerCase().includes('download')) throw new Error('no "download" text in page')
    if (!text.includes(sha256.slice(0, 12))) {
      console.log(`      (note: sha256 prefix not surfaced on page — worker may not print it)`)
    }
  })

  await step('GET  /share/:slug/download (302 → signed R2)', async () => {
    const r = await fetch(`${shareUrl}/download`, { redirect: 'manual' })
    if (r.status !== 302 && r.status !== 200) throw new Error(`HTTP ${r.status}`)
    if (r.status === 302) {
      const loc = r.headers.get('location')
      if (!loc || !loc.includes(sha256)) throw new Error(`redirect location missing sha: ${loc}`)
    }
  })

  await step('POST /api/share/revoke/:slug (cleanup)', async () => {
    const r = await fetchJson(`${BASE}/api/share/revoke/${slug}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    if (r.status !== 200 && r.status !== 204) throw new Error(`HTTP ${r.status}`)
  })

  await step('GET  /share/:slug (post-revoke → 404 or 410)', async () => {
    const r = await fetch(shareUrl)
    if (r.status !== 404 && r.status !== 410) throw new Error(`expected 404/410, got ${r.status}`)
  })

  console.log(`\n\x1b[32mAll green.\x1b[0m Deployment looks healthy.`)
}

main().catch((e) => {
  console.error(`\n\x1b[31mSmoke test FAILED:\x1b[0m ${e.message}`)
  process.exit(1)
})
