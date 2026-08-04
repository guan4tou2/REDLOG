import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

  describe('verifyChainFull signature roll-up', () => {
    it('counts signed rows and reports zero bad signatures on a clean chain', () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'clean-op', name: 'Clean', token })
      events.insertEvent('marker', { i: 1 }, { operatorId: 'clean-op' })
      events.insertEvent('marker', { i: 2 }, { operatorId: 'clean-op' })

      const r = anchor.verifyChainFull()
      expect(r.ok).toBe(true)
      expect(r.walked).toBe(2)
      expect(r.signedCount).toBe(2)
      expect(r.unsignedCount).toBe(0)
      expect(r.badSignatureAtEventId).toBeNull()
    })

    it('reports unsignedCount for rows written by pre-v0.6.89 operators', () => {
      // insertEvent with an operator that has no key row → signature=null.
      events.insertEvent('marker', { i: 1 }, { operatorId: 'legacy-op' })
      events.insertEvent('marker', { i: 2 }, { operatorId: 'legacy-op' })
      const r = anchor.verifyChainFull()
      expect(r.ok).toBe(true)
      expect(r.signedCount).toBe(0)
      expect(r.unsignedCount).toBe(2)
    })

    it('flags a row whose signature no longer verifies (tamper signal)', () => {
      const token = ops.generateToken()
      ops.createOperator({ id: 'tamper-op', name: 'Tamper', token })
      const good = events.insertEvent('marker', { i: 1 }, { operatorId: 'tamper-op' })!
      const bad = events.insertEvent('marker', { i: 2 }, { operatorId: 'tamper-op' })!
      events.insertEvent('marker', { i: 3 }, { operatorId: 'tamper-op' })

      // Overwrite the middle row's signature with a valid-length but wrong
      // signature. Append-only triggers only guard hash/prev_hash/data/id/
      // timestamp/operator_id — signature isn't in that list (rewriting a
      // sig is exactly the tamper case we want verifyChainFull to catch).
      const forgedSig = Buffer.alloc(64, 0xaa).toString('base64')
      getDB().prepare(`UPDATE events SET signature = ? WHERE id = ?`).run(forgedSig, bad.id)

      const r = anchor.verifyChainFull()
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
