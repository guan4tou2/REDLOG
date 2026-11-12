import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let signing: typeof import('../src/core/signing')
let anchor: typeof import('../src/core/chain-anchor')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  signing = await import('../src/core/signing')
  anchor = await import('../src/core/chain-anchor')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('signing (v0.6.89)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-signing-'))
    initDB(tmpDir)
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('key primitives', () => {
    it('round-trips generate → sign → verify', () => {
      const id = 'kp-round-trip-' + Math.random().toString(36).slice(2, 8)
      const kp = signing.generateOperatorKeyPair(id)
      expect(kp.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/)
      expect(Buffer.from(kp.publicKey, 'base64')).toHaveLength(32)
      expect(fs.existsSync(kp.privateKeyPath)).toBe(true)

      const msg = '{"hello":"world"}'
      const sig = signing.signEvent(msg, id)
      expect(sig).not.toBeNull()
      expect(Buffer.from(sig!, 'base64')).toHaveLength(64)
      expect(signing.verifyEventSignature(msg, sig!, kp.publicKey)).toBe(true)
    })

    it('verify rejects a wrong public key', () => {
      const idA = 'kp-a-' + Math.random().toString(36).slice(2, 8)
      const idB = 'kp-b-' + Math.random().toString(36).slice(2, 8)
      signing.generateOperatorKeyPair(idA)
      const kpB = signing.generateOperatorKeyPair(idB)

      const msg = 'canonical-json-here'
      const sig = signing.signEvent(msg, idA)!
      expect(signing.verifyEventSignature(msg, sig, kpB.publicKey)).toBe(false)
    })

    it('verify rejects tampered payload', () => {
      const id = 'kp-tamper-' + Math.random().toString(36).slice(2, 8)
      const kp = signing.generateOperatorKeyPair(id)
      const msg = 'original-payload'
      const sig = signing.signEvent(msg, id)!
      expect(signing.verifyEventSignature('modified-payload', sig, kp.publicKey)).toBe(false)
    })

    it('signEvent returns null when the key file is missing', () => {
      const sig = signing.signEvent('anything', 'operator-that-never-existed')
      expect(sig).toBeNull()
    })
  })

  describe('event insertion', () => {
    it('signs new events for operators with a keypair', () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'signer-op', name: 'Signer', token })

      const ev = events.insertEvent('marker', { note: 'signed one' }, { operatorId: 'signer-op' })
      expect(ev).not.toBeNull()
      expect(ev!.signature).not.toBeNull()
      expect(Buffer.from(ev!.signature!, 'base64')).toHaveLength(64)

      const row = getDB().prepare(`SELECT signature FROM events WHERE id = ?`).get(ev!.id) as { signature: string | null }
      expect(row.signature).toBe(ev!.signature)
    })

    it('leaves signature null for operators without a keypair (legacy path)', () => {
      // Skip createOperator so no key ever gets minted; insertEvent must
      // still succeed — chain hash keeps the row protected.
      const ev = events.insertEvent('marker', { note: 'unsigned' }, { operatorId: 'unknown-op' })
      expect(ev).not.toBeNull()
      expect(ev!.signature).toBeNull()

      const row = getDB().prepare(`SELECT signature FROM events WHERE id = ?`).get(ev!.id) as { signature: string | null }
      expect(row.signature).toBeNull()
    })
  })

  describe('verifyChainFullAsync signature roll-up', () => {
    it('counts signed rows and reports zero bad signatures on a clean chain', async () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'clean-op', name: 'Clean', token })
      events.insertEvent('marker', { i: 1 }, { operatorId: 'clean-op' })
      events.insertEvent('marker', { i: 2 }, { operatorId: 'clean-op' })

      const r = await anchor.verifyChainFullAsync()
      expect(r.ok).toBe(true)
      expect(r.walked).toBe(2)
      expect(r.signedCount).toBe(2)
      expect(r.unsignedCount).toBe(0)
      expect(r.badSignatureAtEventId).toBeNull()
    })

    it('reports unsignedCount for rows written by pre-v0.6.89 operators', async () => {
      // insertEvent with an operator that has no key row → signature=null.
      events.insertEvent('marker', { i: 1 }, { operatorId: 'legacy-op' })
      events.insertEvent('marker', { i: 2 }, { operatorId: 'legacy-op' })
      const r = await anchor.verifyChainFullAsync()
      expect(r.ok).toBe(true)
      expect(r.signedCount).toBe(0)
      expect(r.unsignedCount).toBe(2)
    })

    it('a replayed row attributed to an operator with no public key keeps the chain intact but not authenticated', async () => {
      // project-open-rollback replays a spooled event whose operator is
      // 'spool-operator', which has no key. ok must stay true: authentication
      // is its own fact, and ok:false with no broken event reads as tampering.
      const token = ops.generateToken()
      ops.createOperator({ id: 'real-op', name: 'Real', token })
      events.insertEvent('marker', { i: 1 }, { operatorId: 'real-op' })
      const replayed = events.insertEvent('marker', { i: 2 }, { operatorId: 'spool-operator' })!

      const r = await anchor.verifyChainFullAsync()
      expect(r.ok).toBe(true)
      expect(r.brokenAtEventId).toBeNull()
      expect(r.brokenReason).toBeNull()
      expect(r.authentication).toBe('failed')
      expect(r.authenticationReasons.length).toBeGreaterThan(0)
      expect(r.firstUncheckedEventId).toBe(replayed.id)
    })

    it('flags a row whose signature no longer verifies (tamper signal)', async () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'tamper-op', name: 'Tamper', token })
      const good = events.insertEvent('marker', { i: 1 }, { operatorId: 'tamper-op' })!
      const bad = events.insertEvent('marker', { i: 2 }, { operatorId: 'tamper-op' })!
      events.insertEvent('marker', { i: 3 }, { operatorId: 'tamper-op' })

      // Overwrite the middle row's signature with a valid-length but wrong
      // signature. v0.6.93 P0-F extended the append-only trigger to cover
      // `signature` too — so we simulate the "attacker bypassed the trigger"
      // scenario by temporarily dropping it, forging the sig, then restoring.
      // This is exactly the tamper case verifyChainFull must catch even when
      // the trigger has been circumvented (e.g. direct sqlite3 CLI).
      const forgedSig = Buffer.alloc(64, 0xaa).toString('base64')
      const db = getDB()
      db.exec(`DROP TRIGGER IF EXISTS no_update_events_hash`)
      db.prepare(`UPDATE events SET signature = ? WHERE id = ?`).run(forgedSig, bad.id)

      const r = await anchor.verifyChainFullAsync()
      expect(r.ok).toBe(false)
      expect(r.brokenAtEventId).toBe(bad.id)
      expect(r.brokenReason).toBe('signature invalid')
      expect(r.badSignatureAtEventId).toBe(bad.id)
      // We short-circuit at the bad row, so only `good` was counted.
      expect(r.signedCount).toBe(1)
      void good
    })
  })
})

describe('operator id as a key file name', () => {
  it('accepts any single path segment (Unicode, inner spaces) and rejects separators, controls, . and ..', () => {
    const s = signing
    if (!s) return
    for (const ok of ['operator-1', 'alice-x7k2q9', 'A_b.c', '王小明', 'red team 1', '.x', 'a..b']) expect(s.isSafeOperatorId(ok)).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.', '..', 'a\u0000b', 'a\nb', 'a:b', 'a?b', 'end.', 'end ', 'x'.repeat(129)]) expect(s.isSafeOperatorId(bad)).toBe(false)
  })

  it('never writes a key outside keys/ and signs nothing for a bad id', () => {
    const s = signing
    if (!s) return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-keyname-'))
    const prev = process.env.REDLOG_KEYS_DIR
    process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
    try {
      expect(() => s.generateOperatorKeyPair('../escape')).toThrow(/plain file name/)
      expect(s.signEvent('{}', '../escape')).toBeNull()
      expect(fs.readdirSync(root).sort()).toEqual(['keys'])
      expect(fs.readdirSync(path.join(root, 'keys'))).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.REDLOG_KEYS_DIR; else process.env.REDLOG_KEYS_DIR = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('operator ids that are not ASCII slugs', () => {
  it.each(['王小明', 'red team 1'])('%s gets a key and signs', (id) => {
    const s = signing
    if (!s) return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-keyname-'))
    const prev = process.env.REDLOG_KEYS_DIR
    process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
    try {
      s.resetSigningCache()
      const kp = s.generateOperatorKeyPair(id)
      const sig = s.signEvent('{"a":1}', id)
      expect(sig).toBeTruthy()
      expect(s.verifyEventSignature('{"a":1}', sig!, kp.publicKey)).toBe(true)
      expect(fs.existsSync(path.join(root, 'keys', `${id}.key`))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.REDLOG_KEYS_DIR; else process.env.REDLOG_KEYS_DIR = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('operator id that cannot name a key file', () => {
  it('logs once per id and writes unsigned', () => {
    const s = signing
    if (!s) return
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      s.resetSigningCache()
      expect(s.signEvent('{}', 'bad/id-once')).toBeNull()
      expect(s.signEvent('{}', 'bad/id-once')).toBeNull()
      expect(spy.mock.calls.filter((c) => String(c[0]).includes('bad/id-once'))).toHaveLength(1)
    } finally { spy.mockRestore() }
  })
})
