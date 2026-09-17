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

  // The §5c operator-management IPCs (operators:create/rename/pubKey) lean on
  // these three, so pin their contract here rather than only in the IPC layer.
  describe('§5c management surface', () => {
    it('slugifyOperatorId derives a collision-resistant id the create IPC uses as a PK', () => {
      // <base>-<6 random chars>: the random suffix means two operators can share
      // a display name and still get distinct ids (no forced rename).
      expect(ops.slugifyOperatorId('Codex Agent')).toMatch(/^codex-agent-[a-z0-9]{6}$/)
      expect(ops.slugifyOperatorId('Red Team!')).not.toBe(ops.slugifyOperatorId('Red Team!'))
      // A name with no slug-able characters still yields a usable PK.
      expect(ops.slugifyOperatorId('  ')).toMatch(/^op-[a-z0-9]{6}$/)
    })

    it('renameOperator changes the display name, keeps id and token', () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'r1', name: 'Old', token })
      expect(ops.renameOperator('r1', 'New')).toBe(true)
      expect(ops.listOperators().find((o) => o.id === 'r1')?.name).toBe('New')
      // Rename is not a credential change — the token still resolves.
      expect(ops.resolveOperatorByToken(token)?.id).toBe('r1')
      expect(ops.renameOperator('ghost', 'X')).toBe(false)
    })

    it('getOperatorSignerPubKey returns the key the list surfaces for §5c display', () => {
      const op = ops.createOperator({ id: 'k1', name: 'Signer', token: ops.generateToken() })
      const pub = ops.getOperatorSignerPubKey('k1')
      // Signing may degrade to unsigned (no writable home), but whatever the
      // create returned is what the standalone getter must return.
      expect(pub).toBe(op.signerPubKey)
      expect(ops.getOperatorSignerPubKey('ghost')).toBeNull()
    })
  })
})
