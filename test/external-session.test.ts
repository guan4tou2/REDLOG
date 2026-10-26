import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe.skipIf(process.platform === 'win32')('explicit external PTY session', () => {
  async function session(maxBytes: number, paused: boolean | 'offline' = false, command = ['/bin/sh', '-c', 'test -t 0 && test -t 1 && printf PTY_OK; printf STDERR_OK >&2; exit 7'], interactive = false, transientRead?: 'eof' | 'eio' | 'order') {
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
    if child.poll() is None and sent:
        # The interrupt is in flight; let it land before reaching for SIGTERM,
        # which would report 143 and read as 'the interrupt did nothing'.
        try:
            sys.exit(child.wait(timeout=3))
        except subprocess.TimeoutExpired:
            pass
    if child.poll() is None:
        child.terminate()
    sys.exit(child.wait(timeout=3))
finally:
    os.close(master)
    if child.poll() is None: child.kill()
`
      // Inject only the first master read, leaving the actual child, PTY,
      // subsequent bytes and HTTP recorder intact. A readable PTY can report
      // EOF/EIO before the child is reaped; that is not an exit boundary.
      // 'order' injects nothing: it reports, on stderr, whether the parent
      // closed its slave descriptor before or after reaping the child.
      const orderFault = `
import os, runpy, sys
parent = os.getpid()
slave_fd, reaped = None, False
real_openpty, real_waitpid, real_close = os.openpty, os.waitpid, os.close
def openpty():
    global slave_fd
    master, slave = real_openpty()
    slave_fd = slave
    print('OPENPTY', file=sys.stderr)
    return master, slave
def waitpid(pid, flags):
    global reaped
    result = real_waitpid(pid, flags)
    if os.getpid() == parent and result[0]: reaped = True
    return result
def close(fd):
    if os.getpid() == parent and fd == slave_fd:
        print('CLOSE_SLAVE_AFTER_REAP' if reaped else 'CLOSE_SLAVE_BEFORE_REAP', file=sys.stderr)
    return real_close(fd)
os.openpty, os.waitpid, os.close = openpty, waitpid, close
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`
      const eofFault = `
import errno, os, runpy, sys
original_openpty, original_read = os.openpty, os.read
master_fd, injected = None, False
def openpty():
    global master_fd
    master, slave = original_openpty()
    master_fd = master
    return master, slave
def read(fd, size):
    global injected
    if fd == master_fd and not injected:
        injected = True
        print('INJECTED_PTY_${transientRead}', file=sys.stderr)
        ${transientRead === 'eio' ? "raise OSError(errno.EIO, 'transient PTY read')" : "return b''"}
    return original_read(fd, size)
os.openpty, os.read = openpty, read
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`
      const readFault = transientRead === 'order' ? orderFault : eofFault
      const child = spawn('python3', [...(interactive ? ['-c', driver] : transientRead ? ['-c', readFault] : []), 'hooks/redlog-session.py', '--max-bytes', String(maxBytes), '--',
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

  it.each(['eof', 'eio'] as const)('drains real output after a transient PTY %s while the command is alive', async (failure) => {
    const r = await session(4096, false, ['/bin/sh', '-c', 'printf READ_RETRY; printf STDERR_RETRY >&2; sleep 0.1; exit 7'], false, failure)
    expect(r.diagnostic).toContain(`INJECTED_PTY_${failure}`)
    expect(r.output).toContain('READ_RETRY')
    expect(r.output).toContain('STDERR_RETRY')
    expect(r.code).toBe(7)
    const recorded = r.events.filter(e => e.subtype === 'session_output').map(e => e.stdout).join('')
    expect(recorded).toContain('READ_RETRY')
    expect(recorded).toContain('STDERR_RETRY')
    expect(r.events.at(-1)).toMatchObject({ subtype: 'session_end', exitCode: 7, outputBytes: Buffer.byteLength(recorded), omittedBytes: 0 })
  })

  it('preserves terminal geometry and interactive interrupt behavior', async () => {
    // READY is printed only once the process that must take the interrupt is
    // the one running, with SIGINT at its default. A shell printing READY and
    // then starting \`sleep\` left a window where ^C reached the shell between
    // the two and the sleep that followed never saw it.
    const waiter = 'import signal, sys, time; signal.signal(signal.SIGINT, signal.SIG_DFL); sys.stdout.write("READY_FOR_INTERRUPT"); sys.stdout.flush(); time.sleep(20)'
    const r = await session(4096, false, ['/bin/sh', '-c', `stty size; exec python3 -c '${waiter}'`], true)
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

  it('continues saving beyond the per-chunk budget without truncating the session', async () => {
    const r = await session(5)
    expect(r.output).toContain('PTY_OK')
    const chunks = r.events.filter(e => e.subtype === 'session_output')
    expect(chunks.map(e => e.stdout).join('')).toContain('PTY_OKSTDERR_OK')
    expect(chunks.every(e => Buffer.byteLength(e.stdout) <= 5)).toBe(true)
    expect(r.events.at(-1)).toMatchObject({ truncated: false, omittedBytes: 0 })
    expect(r.diagnostic).not.toContain('limit reached')
  })

  it('keeps binary and terminal control bytes independently of its readable transcript', async () => {
    const r = await session(8, false, ['python3', '-c', "import sys;sys.stdout.buffer.write(bytes([255,0,27,91,51,49,109,65]))"])
    const chunks = r.events.filter(e => e.subtype === 'session_output')
    const raw = Buffer.concat(chunks.filter(e => e.output_body).map(e => Buffer.from(e.output_body.data, 'base64')))
    expect(raw).toEqual(Buffer.from([255,0,27,91,51,49,109,65]))
    expect(r.events.at(-1)).toMatchObject({ outputBytes: 8, omittedBytes: 0 })
  })

  // The trace exists so a lost-output report can come with a timeline (#333
  // had none). It is attached to issues, so it must never carry the output.
  it('writes an opt-in event trace that names events and byte counts but never the output', async () => {
    const file = path.join(os.tmpdir(), `redlog-trace-${process.pid}-${Date.now()}.log`)
    process.env.REDLOG_SESSION_TRACE = file
    try {
      const r = await session(4096, false, ['/bin/echo', 'SECRET_OUTPUT_TEXT'])
      expect(r.code).toBe(0)
      const trace = fs.readFileSync(file, 'utf8')
      for (const event of ['forked', 'output', 'child-reaped', 'slave-closed', 'loop-exit']) expect(trace).toContain(` ${event}`)
      expect(trace).toMatch(/output bytes=\d+/)
      expect(trace).not.toContain('SECRET_OUTPUT_TEXT')
    } finally {
      delete process.env.REDLOG_SESSION_TRACE
      fs.rmSync(file, { force: true })
    }
  })

  // A refusal to start is the case a bug report most needs a line for, and its
  // message can carry a path under the operator's home, so only the type is kept.
  it('traces a refusal to start by error type, not message', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-refuse-'))
    const file = path.join(home, 'trace.log')
    try {
      const r = spawnSync('python3', ['hooks/redlog-session.py', '--', '/bin/echo', 'x'], {
        env: { ...process.env, HOME: home, REDLOG_SESSION_TRACE: file }
      })
      expect(r.status).toBe(1)
      const trace = fs.readFileSync(file, 'utf8')
      expect(trace).toMatch(/session not-started error=\w+ best_effort=False/)
      expect(trace).not.toContain(home)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // Settings > About > Debug log creates ~/.redlog/debug-enabled; the helper
  // runs outside the app, so that file is the only switch it can see.
  it('traces to ~/.redlog/debug.log only while the debug-log flag file exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-flag-'))
    try {
      const target = (env: Record<string, string> = {}): string => {
        const e = { ...process.env, HOME: home, ...env }
        delete (e as Record<string, string | undefined>).REDLOG_SESSION_TRACE
        Object.assign(e, env)
        return execFileSync('python3', ['-c',
          "import runpy; print(runpy.run_path('hooks/redlog-session.py', run_name='probe')['_trace_target']())"], { env: e }).toString().trim()
      }
      expect(target()).toBe('None')
      fs.mkdirSync(path.join(home, '.redlog'))
      expect(target()).toBe('None')
      fs.writeFileSync(path.join(home, '.redlog', 'debug-enabled'), '')
      expect(fs.realpathSync(path.dirname(target()))).toBe(fs.realpathSync(path.join(home, '.redlog')))
      expect(path.basename(target())).toBe('debug.log')
      expect(target({ REDLOG_SESSION_TRACE: '/tmp/explicit.log' })).toBe('/tmp/explicit.log')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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
  // #333: exit 0, no output, outputBytes 0. macOS drops what the master has
  // not read once the last slave descriptor closes, so a command that is gone
  // before the first read loses its output. It is a race (~1% of runs under
  // CPU load; 15 of 1600 measured, 0 of 1600 with the slave held), which a
  // test cannot reproduce on demand. What it can pin is the property that
  // removes the race: the parent keeps the slave open until the child has
  // been reaped and the master drained.
  it('holds the PTY slave open until the child is reaped', async () => {
    const r = await session(4096, false, ['/bin/echo', 'held-canary'], false, 'order')
    expect(r.diagnostic).toContain('OPENPTY')
    expect(r.diagnostic).toContain('CLOSE_SLAVE_AFTER_REAP')
    expect(r.diagnostic).not.toContain('CLOSE_SLAVE_BEFORE_REAP')
    expect(r.output).toContain('held-canary')
    expect(r.events.filter(e => e.subtype === 'session_output').map(e => e.stdout).join('')).toContain('held-canary')
    expect(r.code).toBe(0)
  })

  // #218: a session inside a session records the same bytes twice. The
  // recorder refuses unless told the outer one has ended.
  it('refuses to start a second recorder inside a session, unless --nested', async () => {
    const run = (args: string[]): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
      const child = spawn('python3', ['hooks/redlog-session.py', ...args, '--', 'true'], {
        env: { ...process.env, REDLOG_EXTERNAL_SESSION: '1', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-nest-')) }
      })
      let stderr = ''
      child.stderr.on('data', (b) => { stderr += b })
      child.on('close', (code) => resolve({ code, stderr }))
    })
    const refused = await run([])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('already inside a redlog-session')
    // With --nested it gets past the guard (and then fails for want of a
    // RedLog to talk to, which is a different message).
    const nested = await run(['--nested'])
    expect(nested.stderr).not.toContain('already inside a redlog-session')
  })

})
