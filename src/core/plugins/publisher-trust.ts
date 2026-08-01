import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'

// Publisher trust store. Separate from ./trust.ts (which pins per-plugin
// content hashes for the run-time gate) — this one records which registry
// publishers the operator is willing to install plugins FROM. Each publisher
// has an Ed25519 public key; every plugin tarball is expected to carry a
// detached signature over its content hash, signed by one of the publisher's
// pinned keys.
//
// Marketplace flow:
//   1. Operator picks a plugin from the registry index.
//   2. If publisher isn't trusted yet, show "Trust <publisher>? Their plugins
//      will be signed with key <fingerprint>." → operator confirms → grant().
//   3. Download tarball. Verify sha256 against index, then verify signature
//      against the pinned publisher key. Any mismatch aborts install.
//
// 🟢 declarative plugins can install from any publisher (unsigned OK for now,
// but we still record where they came from). 🔴 privileged plugins MUST come
// from a trusted publisher and MUST carry a valid signature.

export interface PublisherKey {
  /** short human label ("gutou main", "shop A signing"); UI-only */
  label?: string
  /** SPKI-encoded Ed25519 public key, base64 */
  publicKey: string
  /** when the operator first trusted this key, ms epoch */
  trustedAt: number
  /** operator id that added it */
  trustedBy?: string
}

export interface Publisher {
  /** publisher slug — matches `manifest.publisher` in plugin.json */
  id: string
  /** homepage / contact — surfaced in the UI, never used for auth */
  homepage?: string
  /** every key the operator has pinned for this publisher */
  keys: PublisherKey[]
}

type PublisherStore = Record<string, Publisher>

function storePath(): string {
  return join(homedir(), '.redlog', 'trusted-publishers.json')
}

function read(): PublisherStore {
  const p = storePath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(store: PublisherStore): void {
  const p = storePath()
  mkdirSync(join(homedir(), '.redlog'), { recursive: true })
  writeFileSync(p, JSON.stringify(store, null, 2))
}

export function listPublishers(): Publisher[] {
  return Object.values(read())
}

export function getPublisher(id: string): Publisher | null {
  return read()[id] ?? null
}

export function trustPublisher(id: string, key: PublisherKey, homepage?: string): void {
  const store = read()
  const existing = store[id]
  if (existing) {
    // Additional key for a publisher we already trust — key rotation flow.
    if (!existing.keys.some((k) => k.publicKey === key.publicKey)) existing.keys.push(key)
    if (homepage && !existing.homepage) existing.homepage = homepage
  } else {
    store[id] = { id, homepage, keys: [key] }
  }
  write(store)
}

export function untrustPublisher(id: string): void {
  const store = read()
  if (store[id]) {
    delete store[id]
    write(store)
  }
}

/** SHA-256 fingerprint of an SPKI-encoded Ed25519 public key, as `xx:xx:...`. */
export function fingerprint(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64')
  const hash = createHash('sha256').update(raw).digest('hex')
  return hash.match(/.{2}/g)!.slice(0, 16).join(':')
}

/**
 * Verify a detached Ed25519 signature over `message` using ANY of the pinned
 * keys for `publisherId`. Returns { ok, keyLabel } — keyLabel identifies which
 * key signed, useful for audit-logging the trust decision.
 *
 * Publisher unknown → always fails (no implicit trust).
 */
export function verifySignature(
  publisherId: string,
  message: Buffer | string,
  signatureB64: string
): { ok: true; keyLabel?: string } | { ok: false; reason: string } {
  const pub = read()[publisherId]
  if (!pub) return { ok: false, reason: `publisher not trusted: ${publisherId}` }
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf-8') : message
  const sig = Buffer.from(signatureB64, 'base64')
  for (const k of pub.keys) {
    try {
      const pubKey = createPublicKey({
        key: Buffer.from(k.publicKey, 'base64'),
        format: 'der',
        type: 'spki'
      })
      // Ed25519 uses `null` digest per Node's API.
      if (cryptoVerify(null, msg, pubKey, sig)) {
        return { ok: true, keyLabel: k.label }
      }
    } catch {
      // Malformed key — skip and try the next one.
    }
  }
  return { ok: false, reason: 'no pinned key matched the signature' }
}
