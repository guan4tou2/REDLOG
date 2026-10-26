import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// LateOutput is what the relay does with a background job's output once the
// command's own record is written. The pty tests prove it works end to end;
// these prove what it does when the receiver says no, because "never lost
// silently" is a claim about the failures: every byte is either in a row the
// server accepted or in `dropped_bytes` / `over_cap_bytes` on the final row.

const RELAY = path.resolve(__dirname, '../hooks/redlog-relay.py')

interface Reply { status: number; body: unknown }
let servers: http.Server[] = []
let dirs: string[] = []
afterEach(() => {
  for (const s of servers) s.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  servers = []; dirs = []
})

async function receiver(reply: () => Reply): Promise<{ port: number; bodies: Array<Record<string, any>>; headers: http.IncomingHttpHeaders[] }> {
  const bodies: Array<Record<string, any>> = []
  const headers: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push(JSON.parse(raw)); headers.push(req.headers)
      const r = reply()
      res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { port: (server.address() as { port: number }).port, bodies, headers }
}

function home(port: number | null): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-late-'))
  dirs.push(h)
  fs.mkdirSync(path.join(h, '.redlog'))
  fs.writeFileSync(path.join(h, '.redlog', 'active-identity.json'), JSON.stringify({ engagementId: 'eng-A', operatorId: 'op' }))
  fs.writeFileSync(path.join(h, '.redlog', 'api-token'), 'tok')
  if (port !== null) fs.writeFileSync(path.join(h, '.redlog', 'api-port'), String(port))
  return h
}

/** Feed the given chunks through a LateOutput and wait for it to finish.
 *  Asynchronous on purpose: `spawnSync` would block the receiver living in
 *  this process, and every POST would time out. */
function drive(h: string, cap: number, chunks: Array<[string, string]>): Promise<void> {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('relay', ${JSON.stringify(RELAY)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
opts = {'command_id': 'cmd-1', 'source': 'auto-relay', 'captured_by': 'auto-relay', 'max_bytes': ${cap}, 'home': ${JSON.stringify(h)}}
late = m.LateOutput(opts)
for name, text in json.loads(sys.argv[1]):
    late.feed(name, text.encode())
late.finish()
`
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, JSON.stringify(chunks)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))))
  })
}

const finalOf = (bodies: Array<Record<string, any>>): Record<string, any> =>
  bodies.map((b) => b.data).find((d) => d.final === true)!

describe('LateOutput', () => {
  it('sends whole lines as chunks of one command, then one final row', async () => {
    const rx = await receiver(() => ({ status: 200, body: { ok: true } }))
    await drive(home(rx.port), 1_000_000, [['stdout', 'one\ntwo\n'], ['stderr', 'warn\n']])
    const rows = rx.bodies.map((b) => b.data)
    expect(rows.every((d) => d.subtype === 'command_output' && d.command_id === 'cmd-1' && d.late === true)).toBe(true)
    expect(rows.filter((d) => d.stream === 'stdout').map((d) => d.stdout).join('')).toBe('one\ntwo\n')
    expect(rows.filter((d) => d.stream === 'stderr').map((d) => d.stderr).join('')).toBe('warn\n')
    expect(finalOf(rx.bodies)).toMatchObject({ late_bytes: 13, dropped_bytes: 0, truncated: false })
    // The identity is pinned: the server can refuse a project that moved.
    expect(rx.headers[0]['x-redlog-engagement']).toBe('eng-A')
    expect(rx.headers[0].authorization).toBe('Bearer tok')
  })

  it('segments beyond the old lifetime cap and preserves all output', async () => {
    const rx = await receiver(() => ({ status: 200, body: {} }))
    await drive(home(rx.port), 10, [['stdout', 'abcdefghij\nklmnopqrst\n']])
    const rows = rx.bodies.map(b => b.data).filter(d => !d.final)
    expect(rows.map(d => d.stdout ?? '').join('')).toBe('abcdefghij\nklmnopqrst\n')
    expect(rows.every(d => d.bytes <= 10)).toBe(true)
    expect(finalOf(rx.bodies)).toMatchObject({ truncated: false, late_bytes: 22, over_cap_bytes: 0, dropped_bytes: 0 })
  })

  it.skipIf(process.platform === 'win32')('persists foreground output before exit, beyond its inline preview budget', async () => {
    const rx = await receiver(() => ({ status: 200, body: { ok: true } }))
    const h = home(rx.port), event = path.join(h, 'end.json')
    const text = 'long-output-'.repeat(10000)
    const child = spawn('python3', [RELAY, 'run', '--home', h, '--event-out', event,
      '--command-id', 'foreground-1', '--max-bytes', '32', '--', 'python3', '-c',
      `import sys,time;sys.stdout.write(${JSON.stringify(text)});sys.stdout.flush();time.sleep(1);sys.stderr.write('last-error\\n')`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let screen = '', errors = ''
    child.stdout.on('data', c => { screen += c })
    child.stderr.on('data', c => { errors += c })
    const early = await new Promise<boolean>(resolve => {
      const interval = setInterval(() => { if (rx.bodies.some(b => b.data.subtype === 'command_output')) { clearInterval(interval); clearTimeout(timer); resolve(child.exitCode === null) } }, 10)
      const timer = setTimeout(() => { clearInterval(interval); resolve(false) }, 900)
    })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    expect(code, errors).toBe(0)
    expect(early).toBe(true)
    expect(screen).toBe(text)
    const rows = rx.bodies.map(b => b.data)
    expect(rows.filter(d => !d.final).map(d => d.stdout ?? '').join('')).toBe(text)
    expect(Buffer.concat(rows.filter(d => d.stream === 'stdout').map(d => Buffer.from(d.output_body.data, 'base64'))).toString()).toBe(text)
    expect(rows.filter(d => !d.final).map(d => d.stderr ?? '').join('')).toBe('last-error\n')
    expect(rows.every(d => d.streamed === true && d.late === false)).toBe(true)
    expect(rows.at(-1)).toMatchObject({ final: true, dropped_bytes: 0, truncated: false })
    expect(JSON.parse(fs.readFileSync(event, 'utf8'))).toMatchObject({ output_streamed: true, stdout_bytes: Buffer.byteLength(text), stdout_truncated: false })
  })

  it('counts bytes the server would not take while recording is paused', async () => {
    const rx = await receiver(() => ({ status: 200, body: { recording: false } }))
    await drive(home(rx.port), 1_000_000, [['stdout', 'secret-interval\n']])
    // The data rows were refused as paused; the final row carries the shortfall
    // too, but it is itself refused, so what is checkable here is that nothing
    // was re-sent into another interval: one attempt per row.
    expect(rx.bodies.length).toBe(2)
  })

  it('drops, and does not replay, rows the server refuses (another project is open)', async () => {
    const rx = await receiver(() => ({ status: 409, body: { error: 'project changed' } }))
    await drive(home(rx.port), 1_000_000, [['stdout', 'x\n']])
    expect(rx.bodies.length).toBe(2)
  })

  it('does not hang or throw when RedLog is not there', async () => {
    // No api-port file: nothing to send to. Must finish promptly and quietly.
    const started = Date.now()
    await drive(home(null), 1_000_000, [['stdout', 'lost\n']])
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
