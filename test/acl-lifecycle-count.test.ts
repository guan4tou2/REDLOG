import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { requires } from './helpers/requires'
import { clearIcacls, icaclsRestricted, icaclsTargets, installIcaclsRecorder } from './helpers/icacls'

// How many restrictions each lifecycle step makes on Windows, and of which
// paths. Each restriction is three icacls processes that block the main
// process (the one that ingests) for as long as Windows takes to start them,
// up to 10 s for the three together. Project open used to
// restrict the mirrored ~/.redlog/api-token every time although it is rewritten
// in place and keeps its ACL; it now does that once per file identity
// (src/core/fs-acl.ts restrictToOwnerOnce). The lists are exact, so a new call
// on these paths has to be added here on purpose, and a protected path that
// stops being restricted fails here too.

// Read before any test here installs the record itself.
const installedBySetup = typeof (globalThis as Record<symbol, unknown>)[Symbol.for('redlog.test.icaclsRunner')] === 'object'

const sqlite = requires('better-sqlite3')
const listen = requires('listen')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-count-home-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME
const TOKEN = path.join(HOME, '.redlog', 'api-token')
const PORT = path.join(HOME, '.redlog', 'api-port')
const KEYS = process.env.REDLOG_KEYS_DIR!

let db: typeof import('../src/core/db/index')
let api: typeof import('../src/core/api-server')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  api = await import('../src/core/api-server')
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const dirs: string[] = []
const project = (name: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-acl-${name}-`))
  dirs.push(d)
  return d
}

/** What `step` restricted, in order: one entry per restriction. Each
 *  restriction is exactly three icacls processes (/reset, /grant:r,
 *  /inheritance:r on the same path), so the processes started are three times
 *  the length of this list. */
function spawned(step: () => unknown): string[] {
  clearIcacls()
  step()
  const restricted = icaclsRestricted()
  expect(icaclsTargets(), 'each restriction is three icacls processes on its path').toEqual(restricted.flatMap((p) => [p, p, p]))
  return restricted
}

function open(dir: string): void {
  api.onApiProjectClose()
  db.initDB(dir)
  api.onApiProjectOpen()
}

sqlite.describe('icacls calls per lifecycle step on Windows', () => {
  beforeAll(() => {
    // Load the native module as this platform before pretending to be win32.
    db.initDB(project('warm'))
    db.closeDB()
  })
  beforeEach(() => {
    // A fresh record and an empty memo: each test starts as a new process.
    installIcaclsRecorder()
    Object.defineProperty(process, 'platform', { value: 'win32' })
      api.configureApi({ engagementId: 'E', operatorId: 'op', operatorName: 'Op' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
  })
  afterAll(() => {
    try { db.closeDB() } catch { /* */ }
    for (const d of [...dirs, HOME]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('create, then switch: the mirrored token once, then nothing on an open', () => {
    const a = project('a'), b = project('b')
    // First project: its token, the mirror, the keys directory, the operator's key.
    expect(spawned(() => open(a))).toEqual([path.join(a, 'api-token'), TOKEN, KEYS, path.join(KEYS, 'op.key')])
    // A second project: only its own new token.
    expect(spawned(() => open(b))).toEqual([path.join(b, 'api-token')])
    // Switching between projects that exist starts no process at all.
    expect(spawned(() => open(a))).toEqual([])
    expect(spawned(() => open(b))).toEqual([])
    expect(spawned(() => open(a))).toEqual([])
  })

  it('a new operator on an open project: only its key', () => {
    const a = project('op')
    open(a)
    expect(spawned(() => api.setPrimaryOperator('op-2', 'Op Two'))).toEqual([path.join(KEYS, 'op-2.key')])
  })

  it('a mirrored token file replaced since is restricted again on the next open', () => {
    const a = project('replaced')
    open(a)
    fs.rmSync(TOKEN)
    fs.writeFileSync(TOKEN, 'someone else wrote this')
    expect(spawned(() => open(a))).toEqual([TOKEN])
  })

  listen.it('app start restricts the token and the port; the first open of an existing project then starts none', async () => {
    const a = project('start')
    open(a)
    installIcaclsRecorder() // a new process
    clearIcacls()
    await api.startApiServer(0)
    try {
      expect(icaclsRestricted()).toEqual([TOKEN, PORT])
      expect(icaclsTargets()).toHaveLength(6)
      expect(spawned(() => open(a))).toEqual([])
    } finally {
      api.stopApiServer()
    }
  })
})

describe('the record this file counts on', () => {
  it('is installed by test/setup.ts for every file', () => {
    expect(installedBySetup, 'test/setup.ts must call installIcaclsRecorder(), or every suite that opens a project spawns icacls on Windows').toBe(true)
  })
})
