import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { generateKeyPairSync, sign as cryptoSign } from 'crypto'

// The store reads os.homedir(), which on Windows resolves via USERPROFILE
// (not HOME) — so a test that only swaps HOME leaks the operator's real
// trust store into every case. Swap both env vars every time.
async function withTempHome<T>(fn: (mod: typeof import('../src/core/plugins/publisher-trust')) => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pt-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  vi.resetModules()
  const mod = await import('../src/core/plugins/publisher-trust')
  try {
    return await fn(mod)
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeKeypair(): { publicKey: string; privateKey: import('crypto').KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey
  }
}

describe('publisher-trust store', () => {
  it('starts empty and returns null for unknown publishers', async () => {
    await withTempHome(async (mod) => {
      expect(mod.listPublishers()).toEqual([])
      expect(mod.getPublisher('anyone')).toBeNull()
    })
  })

  it('records a trusted publisher and its key', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: kp.publicKey, trustedAt: 1_700_000_000_000, label: 'main' })
      const p = mod.getPublisher('gutou')!
      expect(p.id).toBe('gutou')
      expect(p.keys).toHaveLength(1)
      expect(p.keys[0].publicKey).toBe(kp.publicKey)
    })
  })

  it('adds a new key on re-trust (rotation) without duplicating', async () => {
    await withTempHome(async (mod) => {
      const a = makeKeypair()
      const b = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: a.publicKey, trustedAt: 1 })
      mod.trustPublisher('gutou', { publicKey: a.publicKey, trustedAt: 2 })   // dup
      mod.trustPublisher('gutou', { publicKey: b.publicKey, trustedAt: 3 })   // rotate
      const p = mod.getPublisher('gutou')!
      expect(p.keys).toHaveLength(2)
      expect(p.keys.map((k) => k.publicKey).sort()).toEqual([a.publicKey, b.publicKey].sort())
    })
  })

  it('untrust drops the publisher entirely', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: kp.publicKey, trustedAt: 1 })
      mod.untrustPublisher('gutou')
      expect(mod.getPublisher('gutou')).toBeNull()
    })
  })
})

describe('publisher-trust verifySignature', () => {
  it('verifies a signature made by a pinned key', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: kp.publicKey, trustedAt: 1 })
      const msg = Buffer.from('sha256:abcd', 'utf-8')
      const sig = cryptoSign(null, msg, kp.privateKey).toString('base64')
      const v = mod.verifySignature('gutou', msg, sig)
      expect(v.ok).toBe(true)
    })
  })

  it('rejects a signature that does not match any pinned key', async () => {
    await withTempHome(async (mod) => {
      const trusted = makeKeypair()
      const attacker = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: trusted.publicKey, trustedAt: 1 })
      const msg = Buffer.from('sha256:abcd', 'utf-8')
      const sig = cryptoSign(null, msg, attacker.privateKey).toString('base64')
      const v = mod.verifySignature('gutou', msg, sig)
      expect(v.ok).toBe(false)
    })
  })

  it('rejects any signature from an unknown publisher', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      const msg = Buffer.from('sha256:abcd', 'utf-8')
      const sig = cryptoSign(null, msg, kp.privateKey).toString('base64')
      const v = mod.verifySignature('nobody', msg, sig)
      expect(v.ok).toBe(false)
    })
  })

  it('accepts a signature from any of multiple pinned keys (rotation)', async () => {
    await withTempHome(async (mod) => {
      const a = makeKeypair()
      const b = makeKeypair()
      mod.trustPublisher('gutou', { publicKey: a.publicKey, trustedAt: 1 })
      mod.trustPublisher('gutou', { publicKey: b.publicKey, trustedAt: 2 })
      const msg = Buffer.from('sha256:abcd', 'utf-8')
      // sign with the second key; first pinned key mismatches — should still verify.
      const sig = cryptoSign(null, msg, b.privateKey).toString('base64')
      const v = mod.verifySignature('gutou', msg, sig)
      expect(v.ok).toBe(true)
    })
  })
})

describe('publisher-trust fingerprint', () => {
  it('returns a 16-byte colon-separated hex digest of the SPKI key', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      const fp = mod.fingerprint(kp.publicKey)
      expect(fp).toMatch(/^([a-f0-9]{2}:){15}[a-f0-9]{2}$/)
    })
  })

  it('is stable across calls', async () => {
    await withTempHome(async (mod) => {
      const kp = makeKeypair()
      expect(mod.fingerprint(kp.publicKey)).toBe(mod.fingerprint(kp.publicKey))
    })
  })
})
