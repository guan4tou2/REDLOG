import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { AddressInfo } from 'net'

// The uploader imports `https.request` — remap that to `http.request` so we
// can run a plain-HTTP loopback mock instead of standing up a self-signed
// cert. Must happen before the SUT is imported, so vi.mock is used.
vi.mock('https', async () => {
  const httpMod = await import('http')
  return { ...httpMod, default: httpMod, request: httpMod.request }
})

const { httpsUploader } = await import('../src/core/cloud-share-uploader')
import type { PreparedBundle } from '../src/core/cloud-share'

// The httpsUploader is normally exercised end-to-end against a deployed
// Cloudflare Worker. This test stands up a tiny plain-HTTP server that
// impersonates the two endpoints on the wire, so we can assert the client
// half of the wire contract (POST /api/share/init, then PUT <putUrl>).
// Kept small on purpose — the Worker has its own repo and its own tests.

interface MockState {
  initBody: unknown | null
  putBody: Buffer | null
  putContentType: string | null
  initAuth: string | null
}

function startMockServer(state: MockState): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url === '/api/share/init' && req.method === 'POST') {
        state.initAuth = req.headers.authorization ?? null
        state.initBody = JSON.parse(body.toString('utf-8'))
        const addr = req.socket.address() as AddressInfo
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          putUrl: `http://127.0.0.1:${addr.port}/api/share/put/abc?token=t.sig`,
          shareUrl: `http://127.0.0.1:${addr.port}/share/acme-abcd1234`,
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
        }))
      } else if (req.url?.startsWith('/api/share/put/') && req.method === 'PUT') {
        state.putBody = body
        state.putContentType = req.headers['content-type'] ?? null
        res.writeHead(200); res.end('ok')
      } else {
        res.writeHead(404); res.end('nope')
      }
    })
  })
  return new Promise((resolveP) => server.listen(0, '127.0.0.1', () => resolveP(server)))
}

describe('httpsUploader wire contract', () => {
  let server: http.Server
  let baseUrl: string
  const state: MockState = { initBody: null, putBody: null, putContentType: null, initAuth: null }
  const zipPath = path.join(os.tmpdir(), `redlog-uploader-${Date.now()}.zip`)
  const bytes = Buffer.from('PK\x03\x04 pretend-zip')
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')

  beforeAll(async () => {
    fs.writeFileSync(zipPath, bytes)
    server = await startMockServer(state)
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })
  afterAll(() => {
    server.close()
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
  })

  it('POSTs the sha256 + size + engagement + expiresIn, then PUTs the bytes', async () => {
    const prepared: PreparedBundle = {
      zipPath,
      manifest: {
        bundleFormat: 1,
        createdAt: new Date().toISOString(),
        engagement: { id: 'acme-external-2026q3' },
        zipSha256: sha256,
        zipBytes: bytes.length,
        contents: {
          eventCount: 1, sanitizedEventCount: 0, sanitizedEventCountTotal: 0,
          chainHead: null
        }
      },
      // localBundle is unused by the uploader — a stub is fine.
      localBundle: {
        outDir: path.dirname(zipPath),
        manifest: {
          bundleVersion: 1, createdAt: '', hostname: '', engagementId: 'acme',
          signedBy: null, chainHead: null, lastAnchor: null,
          sanitized: { events: 0, totalInDb: 0 }, files: []
        }
      }
    }

    const r = await httpsUploader.upload(prepared, {
      endpoint: baseUrl, bearer: 'test-token', expiresIn: '30d'
    })
    expect(r.ok).toBe(true)
    expect(r.shareUrl).toMatch(/\/share\/acme-abcd1234$/)
    expect(state.initAuth).toBe('Bearer test-token')
    const init = state.initBody as Record<string, unknown>
    expect(init.sha256).toBe(sha256)
    expect(init.sizeBytes).toBe(bytes.length)
    expect(init.engagementId).toBe('acme-external-2026q3')
    expect(init.expiresIn).toBe('30d')
    expect(state.putBody?.equals(bytes)).toBe(true)
    expect(state.putContentType).toBe('application/zip')
  })
})
