// Spec 073 T009 (US1): three things the previous project leaves behind when
// the next one opens. Each is a leak the per-project session removes by
// construction (FR-003, FR-090); until then each is held here as an `it.fails`
// that states the correct behaviour, so the day one is fixed the marker has to
// come off.
//
//   (a) the link monitor's timer survives a project close
//   (b) without an explicit `resetBodiesDirCache()`, a body is written into the
//       previous project's directory
//   (c) a database error from project A keeps project B's verdict dark
//
// (b) and (c) run the real core modules over two real project directories.
// (a) lives in src/main/index.ts, which a test cannot import; it runs main's
// own `startLinkMonitor` and `stopProject` through the doubles of
// test/helpers/project-lifecycle-trace.ts, so what is checked is the code that
// ships. "Switching" in (b) and (c) is `closeDB()` then `initDB()`, which is
// what `stopProject` and `startProject` do to these modules, minus the explicit
// resets main adds (that is the point of (b)).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { makeHarness } from './helpers/project-lifecycle-trace'

const sqlite = requires('better-sqlite3')

let dbMod: typeof import('../src/core/db/index')
let bodies: typeof import('../src/core/http-body-store')
let health: typeof import('../src/core/capture-health')
let hooksMod: typeof import('../src/core/hooks-manager')
let pluginsIndex: typeof import('../src/core/plugins/index')

if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  bodies = await import('../src/core/http-body-store')
  health = await import('../src/core/capture-health')
  hooksMod = await import('../src/core/hooks-manager')
  pluginsIndex = await import('../src/core/plugins/index')
}

describe('the link monitor across a project close (leak a)', () => {
  // RED today: startLinkMonitor sets linkTimer = setInterval(refresh, 20 s) and
  // nothing in stopProject clears it, so one timer per open outlives its project
  // (the plan lists it: "startLinkMonitor ... 今天沒有 stop").
  it.fails('stopProject clears the timer startLinkMonitor started', () => {
    const timer = { timer: 'link' }
    const cleared: unknown[] = []
    const h = makeHarness({
      platform: 'linux',
      functions: ['startLinkMonitor', 'stopProject'],
      initial: { linkTimer: null, recomputeTimer: null, recomputePending: null, overlayWindow: null, tray: null },
      overrides: { setInterval: () => timer, clearInterval: (t: unknown) => { cleared.push(t) } }
    })
    h.call('startLinkMonitor')
    expect(h.trace.calls.filter((c) => c.startsWith('setInterval(')), 'startLinkMonitor starts exactly one interval').toHaveLength(1)
    h.stopProject()
    expect(cleared).toContain(timer)
  })
})

sqlite.describe('what project A leaves in the modules project B uses (leaks b and c)', () => {
  let a = ''
  let b = ''
  beforeEach(() => {
    a = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-leak-a-'))
    b = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-leak-b-'))
    bodies.resetBodiesDirCache()
  })
  afterEach(() => {
    try { dbMod.closeDB() } catch { /* already closed */ }
    bodies.resetBodiesDirCache()
    vi.restoreAllMocks()
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true })
  })

  const body = (text: string) => ({ data: text, encoding: 'text' as const, size: text.length, sha256: '' })
  const files = (dir: string): string[] => (fs.existsSync(path.join(dir, 'http-bodies')) ? fs.readdirSync(path.join(dir, 'http-bodies')).filter((f) => f.endsWith('.body')) : [])

  it('control: with the reset main performs, B\'s body goes into B', () => {
    dbMod.initDB(a); bodies.storeBody(body('from A')); dbMod.closeDB()
    bodies.resetBodiesDirCache()
    dbMod.initDB(b); bodies.storeBody(body('from B'))
    expect(files(a)).toHaveLength(1)
    expect(files(b)).toHaveLength(1)
  })

  // RED today: bodiesDir() caches the directory and trusts it while it exists;
  // nothing but the explicit reset in stopProject invalidates it.
  it.fails('(b) without the explicit reset, B\'s body goes into B\'s directory, not A\'s', () => {
    dbMod.initDB(a); bodies.storeBody(body('from A')); dbMod.closeDB()
    dbMod.initDB(b); bodies.storeBody(body('from B'))
    expect(files(b), 'B has its body').toHaveLength(1)
    expect(files(a), 'A still has only its own').toHaveLength(1)
  })

  const mockHooks = (): void => {
    health.invalidateHooksCache()
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue(
      [{ id: 'shell-zsh', name: 'shell-zsh', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source' as const, hookFile: '' }] as never
    )
    const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([active('pack-host-monitors'), active('pack-windows-output')])
  }

  it('control: a project that is set up and has had no database error reads healthy', () => {
    dbMod.initDB(b)
    mockHooks()
    expect(health.getCaptureHealth().verdict).toBe('healthy')
  })

  // RED today: noteDbError is module state with a 60 s window; closing A and
  // opening B clears none of it, so B reads dark for an error that was A's.
  it.fails('(c) a database error in A does not make B\'s verdict dark', () => {
    dbMod.initDB(a)
    mockHooks()
    health.noteDbError('events', new Error('disk full in A'))
    dbMod.closeDB()
    dbMod.initDB(b)
    const h = health.getCaptureHealth()
    expect(h.lastDbError, 'B shows A\'s error').toBeUndefined()
    expect(h.verdict).toBe('healthy')
  })
})
