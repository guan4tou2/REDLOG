import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Per-project token isolation (docs/DESIGN-OPEN-ITEMS.md §2, PRD A3): each
// engagement carries its own API secret, so a token from one project does not
// authenticate another and a finished engagement's token can be revoked
// independently. DB-backed, so it rides the native-module guard.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let api: typeof import('../src/core/api-server')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
try {
  const d = await import('../src/core/db/index')
  initDB = d.initDB; closeDB = d.closeDB
  api = await import('../src/core/api-server')
  ops = await import('../src/core/db/operators')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

// Back up the global sidecar so a local run doesn't disturb a real instance.
const RC = path.join(os.homedir(), '.redlog')
const TOKEN_PATH = path.join(RC, 'api-token')
const readIf = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

describeDB('per-project token isolation', () => {
  let savedToken: string | null
  let dirA: string
  let dirB: string
  beforeAll(() => {
    savedToken = readIf(TOKEN_PATH)
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tokA-'))
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tokB-'))
    api.configureApi({ engagementId: 'A', operatorId: 'op', operatorName: 'Op' })
  })
  afterAll(() => {
    try { closeDB() } catch { /* */ }
    if (savedToken === null) { try { fs.rmSync(TOKEN_PATH, { force: true }) } catch { /* */ } }
    else { try { fs.writeFileSync(TOKEN_PATH, savedToken, { mode: 0o600 }) } catch { /* */ } }
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  it('each project mints its own token, persisted in the project dir', () => {
    initDB(dirA); api.onApiProjectOpen()
    const tokenA = api.getApiToken()
    expect(tokenA).toBeTruthy()
    expect(fs.existsSync(path.join(dirA, 'api-token'))).toBe(true)

    initDB(dirB); api.onApiProjectOpen()
    const tokenB = api.getApiToken()
    expect(tokenB).toBeTruthy()
    expect(tokenB).not.toBe(tokenA)
    // The global sidecar mirrors whichever project is currently open (for the
    // shell hook / CLI, which read it every call).
    expect(readIf(TOKEN_PATH)).toBe(tokenB)
  })

  it('re-opening a project restores its own token, and the other token no longer resolves', () => {
    initDB(dirA); api.onApiProjectOpen()
    const tokenA = api.getApiToken()
    // A's operator resolves A's token...
    expect(ops.resolveOperatorByToken(tokenA)?.isPrimary).toBe(true)

    // Capture B's token, then switch back to A: B's token must not resolve
    // against A's DB.
    initDB(dirB); api.onApiProjectOpen()
    const tokenB = api.getApiToken()
    initDB(dirA); api.onApiProjectOpen()
    expect(api.getApiToken()).toBe(tokenA)          // A restored from its file
    expect(ops.resolveOperatorByToken(tokenB)).toBeNull() // B's secret is dead here
  })
})
