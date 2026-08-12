// End-to-end mitmproxy capture. Real flow:
//   curl → mitmdump (hooks/mitmproxy-addon.py) → local echo server
// then assert RedLog captured the http_request_start + http_response scanner
// events, INCLUDING the request AND response bodies. Isolated temp HOME.
//
// Skips unless mitmdump is available: set REDLOG_MITMDUMP=/path/to/mitmdump (or
// have `mitmdump` on PATH). `pipx install mitmproxy` / a venv both work.
import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject } from './helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

const MITMDUMP = process.env.REDLOG_MITMDUMP ?? 'mitmdump'
function mitmdumpAvailable(): boolean {
  try { return spawnSync(MITMDUMP, ['--version'], { timeout: 10_000 }).status === 0 } catch { return false }
}

// Resolves once something is accepting TCP on the port, or throws after timeout.
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error(`port ${port} never came up`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

const PROXY_PORT = 8899

test('mitmproxy addon captures request + response bodies end to end', async () => {
  test.skip(!mitmdumpAvailable(), 'mitmdump not installed (set REDLOG_MITMDUMP or add to PATH)')
  test.setTimeout(60_000)

  // 1) A local echo server that reflects the request body in a JSON response.
  const echo = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ echoedBody: body, method: req.method, path: req.url }))
    })
  })
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  const echoPort = (echo.address() as AddressInfo).port

  // 2) RedLog up (API server + token/port on disk under the temp HOME).
  const { app, page, tmpHome } = await launchWithTempHome()
  await openTestProject(page, 'mitm-verify')
  const apiPort = readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()

  // 3) mitmdump with the addon. HOME=tmpHome so the addon reads THIS RedLog's
  //    api-port/token. block_global=false allows proxying to loopback.
  const mitm = spawn(
    MITMDUMP,
    ['-s', join(process.cwd(), 'hooks', 'mitmproxy-addon.py'),
      '--listen-port', String(PROXY_PORT), '--set', 'block_global=false'],
    { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_VERBOSE: 'true' }, stdio: 'pipe' }
  )
  let mitmLog = ''
  mitm.stdout?.on('data', (b: Buffer) => (mitmLog += b.toString()))
  mitm.stderr?.on('data', (b: Buffer) => (mitmLog += b.toString()))
  await waitForPort(PROXY_PORT, 25_000) // wait until the proxy is actually up
  await new Promise((r) => setTimeout(r, 500))

  // 4) A POST with a JSON body, through the proxy, to the echo server. Async
  //    (not execFileSync) — the echo server lives in THIS node event loop, so a
  //    synchronous curl would block it and deadlock (proxy → echo can't answer).
  const curlOut = await new Promise<string>((resolve, reject) => {
    const c = spawn('curl', [
      '-s', '-x', `http://127.0.0.1:${PROXY_PORT}`,
      '-X', 'POST', `http://127.0.0.1:${echoPort}/api/login`,
      '-H', 'content-type: application/json',
      '-d', '{"user":"admin","pass":"s3cr3t-token"}'
    ])
    let out = ''
    c.stdout.on('data', (b: Buffer) => (out += b.toString()))
    c.on('close', () => resolve(out))
    c.on('error', reject)
    setTimeout(() => { c.kill(); reject(new Error('curl timed out')) }, 15_000)
  })
  console.log('[mitm] curl got:', curlOut.slice(0, 120))
  await new Promise((r) => setTimeout(r, 2500)) // addon posts to RedLog async

  // 5) Read back the scanner events RedLog stored.
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/events?agent_type=scanner&limit=50`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const payload = await res.json() as unknown
  const raw = Array.isArray(payload) ? payload : ((payload as { events?: unknown[] }).events ?? [])
  const events = (raw as Array<{ data: unknown }>).map((e) => ({
    data: (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as Record<string, unknown>
  }))
  const req = events.find((e) => e.data?.subtype === 'http_request_start')
  const rsp = events.find((e) => e.data?.subtype === 'http_response')

  console.log('[mitm] scanner events:', events.length,
    'req?', !!req, 'rsp?', !!rsp,
    '\n[mitm] mitmdump log tail:', mitmLog.split('\n').slice(-6).join(' | '))

  mitm.kill('SIGTERM')
  echo.close()

  // Assertions: both directions captured, with bodies.
  expect(req, 'http_request_start event').toBeTruthy()
  expect(rsp, 'http_response event').toBeTruthy()
  expect(String(req?.data?.method)).toBe('POST')
  expect(String(req?.data?.request_body_preview)).toContain('s3cr3t-token')
  expect(String(rsp?.data?.status)).toBe('200')
  expect(String(rsp?.data?.response_preview)).toContain('echoedBody')
  // the flow is paired via flow_id → _causes on the response
  expect(req?.data?.flow_id).toBeTruthy()
  expect(rsp?.data?.flow_id).toBe(req?.data?.flow_id)

  await app.close()
})
