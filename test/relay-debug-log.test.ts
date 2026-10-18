import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Plain zsh commands are recorded through redlog-relay.py, not redlog-session.py,
// so the debug log has to say what the relay decided about each command's
// output: how many bytes it held, whether it counts as complete, whether the
// drain timed out. It must not say what the command was or printed.

describe.skipIf(process.platform === 'win32')('relay debug log', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-relaylog-'))
  const relay = (args: string[], env: Record<string, string>) =>
    spawnSync('python3', ['hooks/redlog-relay.py', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })

  it('records the completeness verdict of a run without the command or its output', () => {
    const dir = tmp()
    const log = path.join(dir, 'trace.log')
    try {
      const r = relay(['run', '--event-out', path.join(dir, 'event.json'), '--', '/bin/echo', 'SECRET_OUTPUT'], { REDLOG_SESSION_TRACE: log })
      expect(r.status).toBe(0)
      const trace = fs.readFileSync(log, 'utf8')
      expect(trace).toMatch(/relay run-emit exit=0 completeness=complete disposition=captured stdout_bytes=14 stderr_bytes=0 limit_hit=- pid=\d+/)
      expect(trace).not.toContain('SECRET_OUTPUT')
      expect(trace).not.toContain(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a drain timeout in finish as not drained, not as empty', () => {
    const dir = tmp()
    const log = path.join(dir, 'trace.log')
    try {
      const r = relay(['finish', '--stdout-part', path.join(dir, 'missing-out'), '--stderr-part', path.join(dir, 'missing-err'),
        '--drain-timeout', '0', '--exit-code', '3', '--duration-sec', '0', '--cwd', '/tmp', '--command-id', 'cid', '--command-line', 'secret-command'], { REDLOG_SESSION_TRACE: log })
      expect(r.status).toBe(0)
      const trace = fs.readFileSync(log, 'utf8')
      expect(trace).toMatch(/relay finish exit=3 completeness=truncated disposition=captured stdout_bytes=0 stderr_bytes=0 drained=False limit_hit=drain-timeout/)
      expect(trace).not.toContain('secret-command')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('follows the same flag file as the session helper, and writes nothing without it', () => {
    const home = tmp()
    try {
      const run = (): void => {
        relay(['run', '--event-out', path.join(home, 'event.json'), '--', '/bin/echo', 'x'], { HOME: home })
      }
      const log = path.join(home, '.redlog', 'debug.log')
      run()
      expect(fs.existsSync(log)).toBe(false)
      fs.mkdirSync(path.join(home, '.redlog'))
      fs.writeFileSync(path.join(home, '.redlog', 'debug-enabled'), '')
      run()
      expect(fs.readFileSync(log, 'utf8')).toMatch(/relay run-emit exit=0/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
