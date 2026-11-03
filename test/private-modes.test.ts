import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findShellTarget, runInShell, hookPath } from './helpers/zsh-pty'

// Engagement data is owner-only on POSIX. Under a 022 umask the defaults are
// 0755 and 0644, which let another local user read commands, cookie values and
// transcripts. Every case creates the thing through the production code path
// with HOME pointed at a temp directory, under the umask a typical login has.

const posixIt = it.skipIf(process.platform === 'win32')
const bits = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8)
const filesUnder = (root: string): string[] =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? [path.join(root, e.name), ...filesUnder(path.join(root, e.name))] : [path.join(root, e.name)])

let home: string
let savedHome: string | undefined
let savedUmask: number | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-modes-'))
  savedHome = process.env.HOME
  process.env.HOME = home
  if (process.platform !== 'win32') savedUmask = process.umask(0o022)
  vi.resetModules()
})

afterEach(() => {
  if (savedUmask !== undefined) process.umask(savedUmask)
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

let dbAvailable = false
try { await import('better-sqlite3').then((m) => new m.default(':memory:').close()); dbAvailable = true } catch { /* native module not built */ }
const dbIt = it.skipIf(process.platform === 'win32' || !dbAvailable)

describe('~/.redlog and the projects directory', () => {
  posixIt('createProject makes ~/.redlog, projects/ and the project directory 0700 and the index 0600', async () => {
    const pm = await import('../src/core/project-manager')
    const meta = pm.createProject('modes')
    expect(bits(path.join(home, '.redlog'))).toBe('700')
    expect(bits(path.join(home, '.redlog', 'projects'))).toBe('700')
    expect(bits(meta.path)).toBe('700')
    expect(bits(path.join(meta.path, 'screenshots'))).toBe('700')
    expect(bits(path.join(home, '.redlog', 'projects.json'))).toBe('600')
  })

  posixIt('does not depend on the umask', async () => {
    process.umask(0o000)
    const pm = await import('../src/core/project-manager')
    const meta = pm.createProject('modes')
    expect(bits(path.join(home, '.redlog'))).toBe('700')
    expect(bits(meta.path)).toBe('700')
    expect(bits(path.join(home, '.redlog', 'projects.json'))).toBe('600')
  })

  dbIt('starting the API server creates ~/.redlog 0700 beside a 0600 token and port file', async () => {
    const api = await import('../src/core/api-server')
    const { LootDetector } = await import('../src/core/loot-detector')
    const db = await import('../src/core/db/index')
    const project = path.join(home, 'proj')
    db.initDB(project)
    const loot = new LootDetector()
    loot.configure({ identity: { projectId: 'p', engagementId: 'e', operatorId: 'o' } })
    api.configureApi({ engagementId: 'e', operatorId: 'o', operatorName: 'O', lootDetector: loot })
    // initDB gives the project directory its own tree; ~/.redlog is only made by the API server.
    expect(fs.existsSync(path.join(home, '.redlog'))).toBe(false)
    try {
      await api.startApiServer(0)
      expect(bits(path.join(home, '.redlog'))).toBe('700')
      expect(bits(path.join(home, '.redlog', 'api-token'))).toBe('600')
      expect(bits(path.join(home, '.redlog', 'api-port'))).toBe('600')
    } finally {
      api.stopApiServer()
      db.closeDB()
    }
  })
})

describe('the project directory and its database', () => {
  dbIt('initDB makes the directories 0700 and timeline.db, -wal and -shm 0600', async () => {
    const db = await import('../src/core/db/index')
    const events = await import('../src/core/db/events')
    const project = path.join(home, '.redlog', 'projects', 'p1')
    db.initDB(project)
    try {
      events.insertEvent('shell', { subtype: 'command_end', command: 'id', exit_code: 0 }, { engagementId: 'e', operatorId: 'o' })
      expect(bits(project)).toBe('700')
      expect(bits(path.join(project, 'screenshots'))).toBe('700')
      expect(bits(path.join(project, 'http-bodies'))).toBe('700')
      expect(bits(path.join(project, 'timeline.db'))).toBe('600')
      expect(bits(path.join(project, 'timeline.db-wal'))).toBe('600')
      expect(bits(path.join(project, 'timeline.db-shm'))).toBe('600')
    } finally { db.closeDB() }
  })

  dbIt('opening a database an older install made 0644 tightens it', async () => {
    const db = await import('../src/core/db/index')
    const project = path.join(home, 'old')
    fs.mkdirSync(project, { mode: 0o755 })
    db.initDB(project)
    db.closeDB()
    fs.chmodSync(path.join(project, 'timeline.db'), 0o644)
    fs.chmodSync(project, 0o755)
    db.initDB(project)
    try {
      expect(bits(path.join(project, 'timeline.db'))).toBe('600')
      expect(bits(path.join(project, 'timeline.db-wal'))).toBe('600')
    } finally { db.closeDB() }
  })
})

describe('export bundles', () => {
  dbIt('the bundle directory is 0700 and everything in it is 0600, a copied 0644 file included', async () => {
    const db = await import('../src/core/db/index')
    const events = await import('../src/core/db/events')
    const { exportBundle } = await import('../src/core/bundle-export')
    const project = path.join(home, '.redlog', 'projects', 'p1')
    db.initDB(project)
    try {
      events.insertEvent('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 }, { engagementId: 'eng', operatorId: 'op' })
      fs.writeFileSync(path.join(project, 'screenshots', 'a.jpg'), 'jpeg', { mode: 0o644 })
      fs.mkdirSync(path.join(project, 'casts'), { mode: 0o755 })
      fs.writeFileSync(path.join(project, 'casts', 's.cast'), '{"version":2}\n', { mode: 0o644 })
      const { outDir } = exportBundle('eng', {})
      expect(fs.existsSync(path.join(outDir, 'screenshots', 'a.jpg'))).toBe(true)
      expect(bits(path.dirname(outDir))).toBe('700')
      expect(bits(outDir)).toBe('700')
      const wrong: string[] = []
      for (const p of filesUnder(outDir)) {
        const want = fs.statSync(p).isDirectory() ? '700' : path.basename(p) === 'verify.sh' ? '700' : '600'
        if (bits(p) !== want) wrong.push(`${path.relative(outDir, p)} ${bits(p)} (want ${want})`)
      }
      expect(wrong).toEqual([])
    } finally { db.closeDB() }
  })
})

describe('the startup pass over an existing install', () => {
  function oldTree(): string {
    const root = path.join(home, '.redlog')
    const dirs = [root, path.join(root, 'projects'), path.join(root, 'projects', 'p1'), path.join(root, 'projects', 'p1', 'exports'),
      path.join(root, 'projects', 'p1', 'exports', 'bundle-1'), path.join(root, 'pending'), path.join(root, 'inflight')]
    for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, 0o755) }
    const files = [path.join(root, 'projects.json'), ...['', '-wal', '-shm'].map((s) => path.join(root, 'projects', 'p1', `timeline.db${s}`)),
      path.join(root, 'projects', 'p1', 'exports', 'bundle-1', 'events.jsonl'), path.join(root, 'pending', 'a.json'), path.join(root, 'inflight', 'm.json')]
    for (const f of files) { fs.writeFileSync(f, 'x'); fs.chmodSync(f, 0o644) }
    fs.writeFileSync(path.join(root, 'projects', 'p1', 'exports', 'bundle-1', 'verify.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(root, 'projects', 'p1', 'exports', 'bundle-1', 'verify.sh'), 0o755)
    return root
  }

  posixIt('makes a 0755/0644 tree owner-only', async () => {
    const root = oldTree()
    const { restrictRedlogHome } = await import('../src/core/private-fs')
    restrictRedlogHome(home)
    const project = path.join(root, 'projects', 'p1')
    for (const d of [root, path.join(root, 'projects'), project, path.join(project, 'exports'), path.join(project, 'exports', 'bundle-1'), path.join(root, 'pending'), path.join(root, 'inflight')]) {
      expect(bits(d), d).toBe('700')
    }
    for (const f of [path.join(root, 'projects.json'), path.join(project, 'timeline.db'), path.join(project, 'timeline.db-wal'), path.join(project, 'timeline.db-shm'),
      path.join(project, 'exports', 'bundle-1', 'events.jsonl'), path.join(root, 'pending', 'a.json'), path.join(root, 'inflight', 'm.json')]) {
      expect(bits(f), f).toBe('600')
    }
    expect(bits(path.join(project, 'exports', 'bundle-1', 'verify.sh'))).toBe('700')
  })

  posixIt('creates ~/.redlog 0700 on a first run', async () => {
    const { restrictRedlogHome } = await import('../src/core/private-fs')
    restrictRedlogHome(home)
    expect(bits(path.join(home, '.redlog'))).toBe('700')
  })

  posixIt('a chmod that fails neither throws nor is reported more than once', async () => {
    oldTree()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }) })
    const { restrictRedlogHome } = await import('../src/core/private-fs')
    expect(() => restrictRedlogHome(home)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('the spool writers outside the app', () => {
  posixIt('the mitmproxy addon and pcap-agent create their spool 0700 and records 0600', () => {
    const run = spawnSync('python3', ['test/fixtures/private-modes-check.py', home], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home }, cwd: path.join(__dirname, '..')
    })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      addon_spool_dir: '0o700', addon_spool_files: ['0o600'],
      addon_inflight_dir: '0o700', addon_inflight_files: ['0o600'],
      pcap_spool_dir: '0o700', pcap_spool_files: ['0o600']
    })
  })

  const target = process.platform === 'win32' ? null : findShellTarget()
  const shellIt = it.skipIf(process.platform === 'win32' || !target)
  for (const builder of ['fast', 'python']) {
    shellIt(`the shell hook spools in a 0700 directory with a 0600 record (${builder} payload builder)`, async () => {
      const script = `
set -u
umask 022
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home"
printf 1 > "$work/home/api-port"          # nothing listens here: the POST fails and the event is spooled
printf t > "$work/home/api-token"
printf '{"engagementId":"eng-1","operatorId":"op-1"}' > "$work/home/active-identity.json"
export _REDLOG_DIR="$work/home" _REDLOG_HOST=127.0.0.1
${builder === 'python' ? 'export REDLOG_PAYLOAD_BUILDER=python' : ''}
source ${hookPath(target!, 'shell-common.sh')}
_redlog_send_event command_start 'id'
mode() { python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$1"; }
echo "DIR=$(mode "$work/home/pending")"
for f in "$work/home/pending"/*.json; do echo "FILE=$(mode "$f")"; done
`
      const result = await runInShell(target!, script, { timeoutMs: 120_000 })
      expect(result.stdout, result.stderr.slice(0, 400)).toMatch(/^DIR=0o700$/m)
      expect(result.stdout.match(/^FILE=.*$/gm)).toEqual(['FILE=0o600'])
    }, 150_000)
  }
})
