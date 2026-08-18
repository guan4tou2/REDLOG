import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import * as signing from '../src/core/signing'

// v0.12.1: signing.ts caches the imported KeyObject per operator to avoid
// 2× fs.readFileSync + JWK parse on every insertEvent. These tests lock the
// cache contract: cache hit path signs correctly, resetSigningCache
// invalidates, missing-key negative cache doesn't leak, generateOperatorKeyPair
// drops any prior negative-cached entry for the same id.

describe('signing cache (v0.12.1)', () => {
  let tmpKeysDir: string

  beforeEach(() => {
    tmpKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-sign-cache-'))
    process.env.REDLOG_KEYS_DIR = tmpKeysDir
    // Reset cache so entries from prior tests (with a different tmp keysDir)
    // don't leak across.
    signing.resetSigningCache()
  })

  afterEach(() => {
    delete process.env.REDLOG_KEYS_DIR
    fs.rmSync(tmpKeysDir, { recursive: true, force: true })
  })

  it('signEvent returns a valid signature after keygen', () => {
    const kp = signing.generateOperatorKeyPair('alice')
    const sig = signing.signEvent('{"a":1}', 'alice')
    expect(sig).not.toBeNull()
    expect(signing.verifyEventSignature('{"a":1}', sig!, kp.publicKey)).toBe(true)
  })

  it('cache hit: subsequent signs do not re-read the key file', () => {
    signing.generateOperatorKeyPair('bob')
    const sig1 = signing.signEvent('{"n":1}', 'bob')
    // Delete the private key file while the KeyObject is cached in-memory —
    // if the sign path still reads from disk, this second call would return
    // null. The cache means it still signs.
    fs.rmSync(path.join(tmpKeysDir, 'bob.key'))
    const sig2 = signing.signEvent('{"n":2}', 'bob')
    expect(sig1).not.toBeNull()
    expect(sig2).not.toBeNull()
    expect(sig1).not.toBe(sig2)  // different messages, different sigs
  })

  it('resetSigningCache(id) forces a re-read on next sign', () => {
    signing.generateOperatorKeyPair('carol')
    signing.signEvent('{}', 'carol')  // populate cache
    fs.rmSync(path.join(tmpKeysDir, 'carol.key'))
    signing.resetSigningCache('carol')
    // Cache dropped, key file gone — should return null instead of signing
    // with a stale KeyObject.
    expect(signing.signEvent('{}', 'carol')).toBeNull()
  })

  it('resetSigningCache() with no arg clears all operators', () => {
    signing.generateOperatorKeyPair('dave')
    signing.generateOperatorKeyPair('eve')
    signing.signEvent('{}', 'dave')
    signing.signEvent('{}', 'eve')
    fs.rmSync(path.join(tmpKeysDir, 'dave.key'))
    fs.rmSync(path.join(tmpKeysDir, 'eve.key'))
    signing.resetSigningCache()
    expect(signing.signEvent('{}', 'dave')).toBeNull()
    expect(signing.signEvent('{}', 'eve')).toBeNull()
  })

  it('missing key negative-caches (does not re-stat every call)', () => {
    // First call — no key, gets null and caches null.
    expect(signing.signEvent('{}', 'ghost')).toBeNull()
    // Now write a key file directly (bypassing generateOperatorKeyPair,
    // which would call resetSigningCache). The negative cache should still
    // hold, so signEvent returns null even though a valid key now exists.
    const kp = signing.generateOperatorKeyPair('ghost-alive')
    fs.copyFileSync(
      path.join(tmpKeysDir, 'ghost-alive.key'),
      path.join(tmpKeysDir, 'ghost.key')
    )
    fs.copyFileSync(
      path.join(tmpKeysDir, 'ghost-alive.pub'),
      path.join(tmpKeysDir, 'ghost.pub')
    )
    // Negative cache still holds → still null.
    expect(signing.signEvent('{}', 'ghost')).toBeNull()
    // Explicit reset → picks up the newly-copied key.
    signing.resetSigningCache('ghost')
    const sig = signing.signEvent('{}', 'ghost')
    expect(sig).not.toBeNull()
    expect(signing.verifyEventSignature('{}', sig!, kp.publicKey)).toBe(true)
  })

  it('generateOperatorKeyPair drops any prior negative cache for that id', () => {
    // Fresh operator — first signEvent negative-caches.
    expect(signing.signEvent('{}', 'frank')).toBeNull()
    // generateOperatorKeyPair MUST reset the cache; otherwise later signs
    // would keep returning null even though the key file now exists.
    signing.generateOperatorKeyPair('frank')
    expect(signing.signEvent('{}', 'frank')).not.toBeNull()
  })
})
