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

interface App {
  projectOpen: boolean
  recording: boolean
  /** `/api/recording` answers 401, as for a token RedLog no longer knows. */
  refuseToken?: boolean
  /** What `/api/recording` answers instead of `{"recording":…}`. */
  recordingBody?: string
}

function serve(app: App): Promise<{ port: number; close: () => void; paths: string[] }> {
  const paths: string[] = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, version: 'test', projectOpen: app.projectOpen })); return }
      if (req.url === '/api/recording' && req.headers.authorization === 'Bearer tok' && !app.refuseToken) {
        res.end(app.recordingBody ?? JSON.stringify({ recording: app.recording })); return
      }
      if (req.url === '/api/recording') { res.statusCode = 401; res.end('{}'); return }
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
    const posix = (p: string): string => p.split(path.sep).join('/')
    return new Promise((resolve, reject) => {
      execFile(shell, [...args, `source "$1"; ${body}; echo "rc=$?"`, 'redlog-status', hook], {
        encoding: 'utf8', timeout: 20_000,
        // Forward slashes, as Git Bash spells `$HOME`: the hook finds the home
        // above `_REDLOG_DIR` by its last `/` (see shell-status.test.ts).
        env: { PATH: process.env.PATH ?? '', HOME: posix(home), _REDLOG_DIR: posix(dir) }
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

    it('RedLog running with no project open: says that, keeps the mode, exits non-zero', async () => {
      const app = await serve({ projectOpen: false, recording: true })
      try {
        const r = await status(app.port)
        expect(r.out).toContain('RedLog running, no project open')
        expect(r.out).not.toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.rc, r.out).not.toBe(0)
        // The token is only sent where there is a project to ask about.
        expect(app.paths.filter((p) => p.includes('/api/recording'))).toEqual([])
      } finally { app.close() }
    })

    it('RedLog not reachable: nothing listens on the port the files name', async () => {
      const r = await status(await freePort())
      expect(r.out).toContain('RedLog not reachable')
      expect(r.out).not.toContain('recording enabled')
      expect(r.out).toContain('mode auto')
      expect(r.rc, r.out).not.toBe(0)
    })

    it('RedLog not reachable: no port file at all', async () => {
      const r = await status(null)
      expect(r.out).toContain('RedLog not reachable')
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

    it('sourcing the hook asks nothing of the app', async () => {
      // A `-c` shell has no prompt hook; that the prompt and the commands typed
      // after it ask nothing is counted in shell-unsaved-notice.test.ts.
      const app = await serve({ projectOpen: true, recording: true })
      try {
        await status(app.port, 'true')
        expect(app.paths).toEqual([])
      } finally { app.close() }
    })

    it('RedLog answers but refuses the token: it is running, and its recording state could not be read', async () => {
      const app = await serve({ projectOpen: true, recording: true, refuseToken: true })
      try {
        const r = await status(app.port)
        expect(r.out).toContain('RedLog running, recording state could not be read')
        expect(r.out).not.toContain('not reachable')
        expect(r.out).not.toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.rc, r.out).not.toBe(0)
      } finally { app.close() }
    })

    for (const recordingBody of ['{}', '{"recording":"yes"}', 'not json']) {
      it(`an answer that does not say "recording":true (${recordingBody}) is not read as recording`, async () => {
        const app = await serve({ projectOpen: true, recording: true, recordingBody })
        try {
          const r = await status(app.port)
          expect(r.out).toContain('recording state could not be read')
          expect(r.out).not.toContain('recording enabled')
          expect(r.rc, r.out).not.toBe(0)
        } finally { app.close() }
      })
    }

    // The hook does not load in a terminal outside the selection; this is the
    // one that loaded, and then the machine's selection changed.
    it('a terminal RedLog is no longer set to record says so, asks nothing, and exits non-zero', async () => {
      const app = await serve({ projectOpen: true, recording: true })
      try {
        const r = await status(app.port, 'printf ghostty-not-me > "$_REDLOG_DIR/terminal-app"; redlog status')
        expect(r.out).toContain('this terminal is not recorded')
        expect(r.out).toContain('ghostty-not-me')
        expect(r.out).not.toContain('recording enabled')
        expect(r.out).toContain('mode auto')
        expect(r.rc, r.out).not.toBe(0)
        expect(app.paths).toEqual([])
      } finally { app.close() }
    })

    // The exit status is the point of the command, and a caller may have errexit
    // on: the line must still be printed, and while recording the status is 0.
    const errexit = shell === 'bash' ? 'set -e' : 'setopt ERR_RETURN'
    it('under the caller\'s errexit, while recording: the line is printed and the script goes on', async () => {
      const app = await serve({ projectOpen: true, recording: true })
      try {
        const r = await status(app.port, `${errexit}; redlog status; echo after-status`)
        expect(r.out).toContain('recording enabled')
        expect(r.out).toContain('after-status')
        expect(r.rc, r.out).toBe(0)
      } finally { app.close() }
    })

    it('under the caller\'s errexit, not recording: the line is printed before the failing status ends the script', async () => {
      const app = await serve({ projectOpen: true, recording: false })
      try {
        const r = await status(app.port, `${errexit}; redlog status; echo after-status`)
        expect(r.out).toContain('recording paused')
        expect(r.out).not.toContain('after-status')
      } finally { app.close() }
    })

    // An alias made after the hook loaded must not stand in for curl: bash and
    // zsh read a `$(…)` again when it runs, with aliases on. Nothing listens on
    // the port, so only a curl that was not asked can say anything but "not
    // reachable".
    it('is not answered by an alias of curl', async () => {
      const r = await status(await freePort(), `shopt -s expand_aliases 2>/dev/null; alias curl='echo {"ok":true,"projectOpen":false}'\nredlog status`)
      expect(r.out).toContain('RedLog not reachable')
      expect(r.rc, r.out).not.toBe(0)
    })
  })
}
