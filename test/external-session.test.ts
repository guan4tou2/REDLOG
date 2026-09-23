import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe.skipIf(process.platform === 'win32')('explicit external PTY session', () => {
  async function session(maxBytes: number, paused: boolean | 'offline' = false, command = ['/bin/sh', '-c', 'test -t 0 && test -t 1 && printf PTY_OK; printf STDERR_OK >&2; exit 7'], interactive = false) {
    const events: Array<Record<string, any>> = []
    const identities: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', b => { body += b })
      req.on('end', () => {
        const event = JSON.parse(body)
        identities.push(String(req.headers['x-redlog-engagement']))
        const skip = paused && event.data.subtype === 'session_output'
        if (!skip) events.push(event.data)
        res.writeHead(skip ? (paused === 'offline' ? 503 : 200) : 201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(skip ? { recording: false } : { id: 'accepted' }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pty-'))
    const dir = path.join(home, '.redlog')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'active-identity.json'), JSON.stringify({ engagementId: 'project-a' }))
    fs.writeFileSync(path.join(dir, 'api-token'), 'token-a')
    fs.writeFileSync(path.join(dir, 'api-port'), String((server.address() as { port: number }).port))
    try {
      const driver = `
import errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 31, 95, 0, 0))
child = subprocess.Popen([sys.executable, *sys.argv[1:]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
seen = b''
sent = False
try:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not chunk: break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        seen += chunk
        if b'READY_FOR_INTERRUPT' in seen and not sent:
            os.write(master, b'\\x03')
            sent = True
    if child.poll() is None:
        child.terminate()
    sys.exit(child.wait(timeout=3))
finally:
    os.close(master)
    if child.poll() is None: child.kill()
`
      const child = spawn('python3', [...(interactive ? ['-c', driver] : []), 'hooks/redlog-session.py', '--max-bytes', String(maxBytes), '--',
        ...command],
      { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.end()
      let output = '', diagnostic = ''
      child.stdout.on('data', b => { output += b })
      child.stderr.on('data', b => { diagnostic += b })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      return { events, identities, output, diagnostic, code }
    } finally {
      await new Promise<void>(r => server.close(() => r()))
      fs.rmSync(home, { recursive: true, force: true })
    }
  }

  it('preserves PTY semantics, merged output, exit status and pinned project', async () => {
    const r = await session(1024)
    expect(r.code).toBe(7)
    expect(r.output).toContain('PTY_OK')
    expect(r.output).toContain('STDERR_OK')
    expect(r.events[0].subtype).toBe('session_start')
    expect(r.events.at(-1)).toMatchObject({ subtype: 'session_end', exitCode: 7, truncated: false })
    expect(r.events.filter(e => e.subtype === 'session_output').map(e => e.stdout).join('')).toContain('PTY_OK')
    expect(new Set(r.identities)).toEqual(new Set(['project-a']))
    expect(new Set(r.events.map(e => e.terminalId)).size).toBe(1)
  })

  it('preserves terminal geometry and interactive interrupt behavior', async () => {
    const r = await session(4096, false, ['/bin/sh', '-c', 'stty size; printf READY_FOR_INTERRUPT; sleep 20'], true)
    expect(r.output).toContain('31 95')
    expect(r.code).toBe(130)
    expect(r.events.at(-1)).toMatchObject({ subtype: 'session_end', exitCode: -2 })
  })

  it('records a failed executable as an explicit exit boundary', async () => {
    const r = await session(4096, false, ['/no-such-redlog-command'])
    expect(r.code).toBe(127)
    expect(r.output).toContain('command could not start')
    expect(r.events.at(-1)).toMatchObject({ subtype: 'session_end', exitCode: 127 })
  })

  it('disables unpinned metadata hooks inside the recorded child', async () => {
    const r = await session(4096, false, ['/bin/bash', '-c', 'source hooks/shell-bash-hook.sh; printf HOOK_SAFE; _redlog_send_event command_start unsafe'])
    expect(r.code).toBe(0)
    expect(r.output).toContain('HOOK_SAFE')
    expect(r.events.every(e => e.source === 'external-session')).toBe(true)
  })

  it('keeps terminal output live beyond the recording cap and declares truncation', async () => {
    const r = await session(1)
    expect(r.output).toContain('PTY_OK')
    expect(r.events.filter(e => e.subtype === 'session_output')).toEqual([])
    expect(r.events.at(-1)).toMatchObject({ truncated: true })
    expect(r.diagnostic).toContain('limit reached')
  })

  it('keeps the command live on capture failure and records the omission', async () => {
    const r = await session(1024, 'offline')
    expect(r.code).toBe(7)
    expect(r.output).toContain('PTY_OK')
    expect(r.events.filter(e => e.subtype === 'session_output')).toEqual([])
    expect(r.events.at(-1)?.omittedBytes).toBeGreaterThan(0)
    expect(r.events.at(-1)?.outputBytes).toBe(0)
    expect(r.diagnostic).toContain('capture unavailable')
  })

  it('does not spool or replay output the server marks paused', async () => {
    const r = await session(1024, true)
    expect(r.output).toContain('PTY_OK')
    expect(r.events.filter(e => e.subtype === 'session_output')).toEqual([])
    expect(r.events.at(-1)?.pausedBytes).toBeGreaterThan(0)
  })
})
