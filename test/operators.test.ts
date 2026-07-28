import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let ops: typeof import('../src/core/db/operators')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  ops = await import('../src/core/db/operators')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const describeDB = dbAvailable ? describe : describe.skip

describeDB('operators', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ops-'))
    initDB(tmpDir)
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ensurePrimaryOperator creates then rotates on re-call', () => {
    const t1 = ops.generateToken()
    const first = ops.ensurePrimaryOperator('op-1', 'Alice', t1)
    expect(first.isPrimary).toBe(true)
    expect(first.id).toBe('op-1')
    expect(ops.resolveOperatorByToken(t1)?.id).toBe('op-1')

    const t2 = ops.generateToken()
    ops.ensurePrimaryOperator('op-1', 'Alice', t2)
    expect(ops.resolveOperatorByToken(t1)).toBeNull()
    expect(ops.resolveOperatorByToken(t2)?.id).toBe('op-1')
  })

  it('resolves distinct operators by their own token', () => {
    const primaryToken = ops.generateToken()
    ops.ensurePrimaryOperator('primary', 'Me', primaryToken)

    const codexToken = ops.generateToken()
    const codex = ops.createOperator({ id: 'codex-1', name: 'Codex', token: codexToken })

    expect(ops.resolveOperatorByToken(primaryToken)?.id).toBe('primary')
    expect(ops.resolveOperatorByToken(codexToken)?.id).toBe('codex-1')
    expect(codex.isPrimary).toBe(false)
  })

  it('revoked operator token no longer resolves', () => {
    const token = ops.generateToken()
    ops.createOperator({ id: 'temp', name: 'Temp', token })
    expect(ops.resolveOperatorByToken(token)?.id).toBe('temp')

    ops.revokeOperator('temp')
    expect(ops.resolveOperatorByToken(token)).toBeNull()
  })

  it('rotating a token invalidates the old one', () => {
    const oldToken = ops.generateToken()
    ops.createOperator({ id: 'agent', name: 'Agent', token: oldToken })
    const newToken = ops.generateToken()
    ops.updateOperatorToken('agent', newToken)

    expect(ops.resolveOperatorByToken(oldToken)).toBeNull()
    expect(ops.resolveOperatorByToken(newToken)?.id).toBe('agent')
  })

  it('cannot delete or revoke the primary operator', () => {
    ops.ensurePrimaryOperator('primary', 'Me', ops.generateToken())
    expect(ops.revokeOperator('primary')).toBe(false)
    expect(ops.deleteOperator('primary')).toBe(false)
  })

  it('unknown token resolves to null', () => {
    expect(ops.resolveOperatorByToken('nope')).toBeNull()
    expect(ops.resolveOperatorByToken('')).toBeNull()
  })
})
