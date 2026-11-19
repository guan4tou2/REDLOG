import { describe, it, expect } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// `redlog status` is what an operator, a prompt segment or a script asks "is
// this terminal being recorded?". It said "recording enabled" while the app was
// closed, paused, or open on the project list. It now asks the app, reads the
// answer from the same two routes the app already has (`/api/health` and
// `/api/recording`), and exits 0 only when this terminal is being recorded.

const python = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0
const curl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0

interface App { projectOpen: boolean; recording: boolean }

function serve(app: App): Promise<{ port: number; close: () => void; paths: string[] }> {
  const paths: string[] = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, version: 'test', projectOpen: app.projectOpen })); return }
      if (req.url === '/api/recording' && req.headers.authorization === 'Bearer tok') {
        res.end(JSON.stringify({ recording: app.recording })); return
      }
      res.statusCode = 404; res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close(), paths })
    })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
}

for (const shell of ['bash', 'zsh'] as const) {
  const available = python && curl && spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  const hook = path.resolve(`hooks/shell-${shell}-hook.${shell === 'zsh' ? 'zsh' : 'sh'}`)

  const status = (port: number | null, body = 'redlog status'): Promise<{ out: string; rc: number }> => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-status-live-'))
    const dir = path.join(home, '.redlog')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'active-identity.json'), JSON.stringify({ engagementId: 'status-project', operatorId: 'status-operator' }))
    if (port !== null) {
      fs.writeFileSync(path.join(dir, 'api-port'), String(port))
      fs.writeFileSync(path.join(dir, 'api-token'), 'tok')
    }
    const args = shell === 'zsh' ? ['-dfc'] : ['--noprofile', '--norc', '-c']
    return new Promise((resolve, reject) => {
      execFile(shell, [...args, `source "$1"; ${body}; echo "rc=$?"`, 'redlog-status', hook], {
        encoding: 'utf8', timeout: 20_000,
        env: { PATH: process.env.PATH ?? '', HOME: home, _REDLOG_DIR: dir }
      }, (error, stdout, stderr) => {
        fs.rmSync(home, { recursive: true, force: true })
        if (error && (error as { killed?: boolean }).killed) { reject(error); return }
        const rc = Number(/rc=(\d+)\s*$/.exec(stdout)?.[1] ?? NaN)
        resolve({ out: stdout.replace(/rc=\d+\s*$/, '') + stderr, rc })
      })
    })
  }

  ;(available ? describe : describe.skip)(`${shell} redlog status asks the app`, () => {
    it('recording: says so, with the project and mode, exit 0', async () => {
      const app = await serve({ projectOpen: true, recording: true })
      try {
        const r = await status(app.port)
        expect(r.out).toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.out).toContain('project status-project')
        expect(r.rc, r.out).toBe(0)
      } finally { app.close() }
    })

    it('paused: says paused, keeps the mode, exits non-zero', async () => {
      const app = await serve({ projectOpen: true, recording: false })
      try {
        const r = await status(app.port)
        expect(r.out).toContain('recording paused')
        expect(r.out).not.toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.rc, r.out).not.toBe(0)
      } finally { app.close() }
    })

    it('app running with no project open: says that, keeps the mode, exits non-zero', async () => {
      const app = await serve({ projectOpen: false, recording: true })
      try {
        const r = await status(app.port)
        expect(r.out).toContain('app running, no project open')
        expect(r.out).not.toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.rc, r.out).not.toBe(0)
        // The token is only sent where there is a project to ask about.
        expect(app.paths.filter((p) => p.includes('/api/recording'))).toEqual([])
      } finally { app.close() }
    })

    it('app not reachable: nothing listens on the port the files name', async () => {
      const r = await status(await freePort())
      expect(r.out).toContain('app not reachable')
      expect(r.out).not.toContain('recording enabled')
      expect(r.out).toContain('mode auto')
      expect(r.rc, r.out).not.toBe(0)
    })

    it('app not reachable: no port file at all', async () => {
      const r = await status(null)
      expect(r.out).toContain('app not reachable')
      expect(r.rc, r.out).not.toBe(0)
    })

    it('a terminal stopped with `redlog stop` keeps saying why, and exits non-zero', async () => {
      const app = await serve({ projectOpen: true, recording: true })
      try {
        const r = await status(app.port, 'redlog stop >/dev/null; redlog status')
        expect(r.out).toContain('stopped (operator)')
        expect(r.rc, r.out).not.toBe(0)
      } finally { app.close() }
    })

    it('asks nothing of the app until `redlog status` is typed', async () => {
      const app = await serve({ projectOpen: true, recording: true })
      try {
        await status(app.port, 'true')
        expect(app.paths).toEqual([])
      } finally { app.close() }
    })
  })
}
