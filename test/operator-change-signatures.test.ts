import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// An operator id is a signer. Each event names the operator that wrote it,
// and verification finds the public key by that id. Changing the operator in
// Settings used to rename the primary operator's row, so every event signed
// before the change named an operator that no longer existed: full verify
// reported "signature invalid", and the old events read as unsigned.
//
// Own HOME and keys dir before the imports: api-server resolves its sidecar
// at module scope, and signing writes keys under the home directory.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-opsig-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
process.env.REDLOG_KEYS_DIR = path.join(FAKE_HOME, 'keys')

let db: typeof import('../src/core/db/index')
let api: typeof import('../src/core/api-server')
let ops: typeof import('../src/core/db/operators')
let events: typeof import('../src/core/db/events')
let anchor: typeof import('../src/core/chain-anchor')
let dbAvailable = false
try {
  db = await import('../src/core/db/index')
  api = await import('../src/core/api-server')
  ops = await import('../src/core/db/operators')
  events = await import('../src/core/db/events')
  anchor = await import('../src/core/chain-anchor')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('changing the operator while a project is open', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(FAKE_HOME, 'proj-'))
    db.initDB(dir)
    api.configureApi({ engagementId: 'eng', operatorId: 'op-1', operatorName: 'One' })
    api.onApiProjectOpen()
  })
  afterAll(() => {
    try { db.closeDB() } catch { /* */ }
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  it('keeps every event verifiable, before and after the change', async () => {
    events.insertEvent('system', { subtype: 'before' }, { engagementId: 'eng', operatorId: 'op-1' })
    expect(api.setPrimaryOperator('op-2', 'Two')).toBe(true)
    events.insertEvent('system', { subtype: 'after' }, { engagementId: 'eng', operatorId: 'op-2' })
    const result = await anchor.verifyChainFullAsync()
    expect(result.ok).toBe(true)
    expect(result.unsignedCount).toBe(0)
    // The first operator is still on record, no longer primary and no longer
    // answering to the project token.
    const byId = Object.fromEntries(ops.listOperators().map((o) => [o.id, o]))
    expect(byId['op-1']).toMatchObject({ isPrimary: false })
    expect(byId['op-1'].revokedAt).not.toBeNull()
    expect(byId['op-2']).toMatchObject({ isPrimary: true, name: 'Two' })
    expect(ops.resolveOperatorByToken(api.getApiToken())?.id).toBe('op-2')
  })

  it('takes back its own row when the operator returns', () => {
    expect(api.setPrimaryOperator('op-1', 'One again')).toBe(true)
    const rows = ops.listOperators()
    expect(rows.filter((o) => o.id === 'op-1')).toHaveLength(1)
    expect(ops.resolveOperatorByToken(api.getApiToken())).toMatchObject({ id: 'op-1', name: 'One again', isPrimary: true })
  })

  it('will not take over another live operator on the project', () => {
    ops.createOperator({ id: 'teammate', name: 'Teammate', token: ops.generateToken() })
    expect(api.setPrimaryOperator('teammate', 'Teammate')).toBe(false)
    expect(ops.getPrimaryOperator()?.id).toBe('op-1')
  })
})
