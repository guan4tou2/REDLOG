import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

// v0.6.89: per-event Ed25519 signature closes the ≤59-minute rewrite window
// left open by hash chain + hourly OTS anchor. Each operator has a keypair;
// events they insert get signed at write time; verifyChainFull walks each
// row's signature against the operator's stored public key.
//
// Storage:
//   Private key: ~/.redlog/keys/<operator_id>.key   (raw 32 bytes, base64, 0600)
//   Public  key: ~/.redlog/keys/<operator_id>.pub   (raw 32 bytes, base64)
//                also mirrored into operators.signer_pub_key so verify never
//                needs the disk-side .pub — the DB is authoritative for
//                history. The disk .pub is a convenience artifact.
//   Signature:   base64 of raw 64-byte Ed25519 signature (Node's default
//                output shape for crypto.sign(null, msg, ed25519Key)).
//
// Why JWK internally instead of raw import? Node's crypto.createPublicKey /
// crypto.createPrivateKey rejects { format: 'raw' } (verified on Node 24 —
// the option is documented but unimplemented for OKP keys). JWK is the
// portable path: raw bytes go base64url into { crv, kty, x[, d] }, and both
// key factories accept format: 'jwk'.

// Tests set REDLOG_KEYS_DIR to isolate from the operator's real ~/.redlog/keys
// directory. Production leaves it unset and lands under homedir().
function keysDir(): string {
  return process.env.REDLOG_KEYS_DIR || path.join(homedir(), '.redlog', 'keys')
}

function ensureKeysDir(): string {
  const dir = keysDir()
  // v0.6.96 Sec-2: create with mode 0700 so other local UIDs can't LIST the
  // keys directory. Private key files inside are already 0600 so their
  // contents were never readable, but dir enumeration leaked which operators
  // existed. `recursive: true` respects `mode` only for created leaves — if
  // dir already exists we chmod to be sure. Windows: no-op (POSIX perms).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700) } catch { /* pre-existing, permission denied */ }
  }
  return dir
}

function privateKeyPath(operatorId: string): string {
  return path.join(keysDir(), `${operatorId}.key`)
}

function publicKeyPath(operatorId: string): string {
  return path.join(keysDir(), `${operatorId}.pub`)
}

// Wrap 32-byte raw public key into a KeyObject via JWK. The Ed25519 SPKI DER
// prefix is a constant (`302a300506032b6570032100`) so we could hand-splice
// it, but JWK is boring and future-proof.
function publicKeyFromRaw(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64, 'base64')
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`)
  return crypto.createPublicKey({
    key: { crv: 'Ed25519', kty: 'OKP', x: raw.toString('base64url') },
    format: 'jwk'
  })
}

function privateKeyFromRaw(rawPrivB64: string, rawPubB64: string): crypto.KeyObject {
  const priv = Buffer.from(rawPrivB64, 'base64')
  const pub = Buffer.from(rawPubB64, 'base64')
  if (priv.length !== 32) throw new Error(`ed25519 private key must be 32 bytes, got ${priv.length}`)
  if (pub.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${pub.length}`)
  return crypto.createPrivateKey({
    key: {
      crv: 'Ed25519', kty: 'OKP',
      x: pub.toString('base64url'),
      d: priv.toString('base64url')
    },
    format: 'jwk'
  })
}

export interface OperatorKeyPair {
  publicKey: string        // base64 raw 32 bytes
  privateKeyPath: string   // absolute path to the .key file
}

// Generate a fresh Ed25519 keypair for `operatorId`, write both halves to
// `~/.redlog/keys/`, and return the base64 public key so the caller can stash
// it in operators.signer_pub_key. Overwrites any existing key — call sites
// treat keygen as idempotent-on-create; rotation is out of scope for v0.6.89
// (rotating the signing key would require a re-sign or supersedes relation).
export function generateOperatorKeyPair(operatorId: string): OperatorKeyPair {
  ensureKeysDir()
  const kp = crypto.generateKeyPairSync('ed25519')
  // Export as JWK to pull the raw 32-byte halves (jwk.d = private, jwk.x = pub).
  const jwkPriv = kp.privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  const privRaw = Buffer.from(jwkPriv.d, 'base64url')
  const pubRaw = Buffer.from(jwkPriv.x, 'base64url')
  const privB64 = privRaw.toString('base64')
  const pubB64 = pubRaw.toString('base64')

  const privPath = privateKeyPath(operatorId)
  const pubPath = publicKeyPath(operatorId)
  // 0o600 on POSIX; Windows ignores the mode and falls back to inherited
  // ACLs. That's best-effort by design — the DB copy is what verify checks.
  fs.writeFileSync(privPath, privB64, { mode: 0o600 })
  fs.writeFileSync(pubPath, pubB64)
  return { publicKey: pubB64, privateKeyPath: privPath }
}

// Sign the pre-computed canonical JSON on behalf of `operatorId`. Returns
// null when the key file is missing — an older operator created before
// v0.6.89, or a key that got wiped — so insertEvent can proceed with an
// unsigned row rather than crash. The chain hash still protects that row;
// verifyChainFull surfaces it as "unsigned" (audit signal), not "broken".
export function signEvent(canonicalJson: string, operatorId: string): string | null {
  const privPath = privateKeyPath(operatorId)
  const pubPath = publicKeyPath(operatorId)
  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) return null
  try {
    const privB64 = fs.readFileSync(privPath, 'utf-8').trim()
    const pubB64 = fs.readFileSync(pubPath, 'utf-8').trim()
    const key = privateKeyFromRaw(privB64, pubB64)
    // Ed25519 uses PureEdDSA — no digest algorithm; pass null.
    const sig = crypto.sign(null, Buffer.from(canonicalJson, 'utf-8'), key)
    return sig.toString('base64')
  } catch {
    // Malformed key file, permissions error, etc. — don't crash the caller.
    return null
  }
}

// Constant-time in Node's `crypto.verify`; returns false on any parse error
// rather than throwing so verifyChainFull can distinguish "tampered / wrong
// key" (false) from "no signature to check" (skipped upstream).
export function verifyEventSignature(canonicalJson: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = publicKeyFromRaw(publicKeyB64)
    const sig = Buffer.from(signatureB64, 'base64')
    if (sig.length !== 64) return false
    return crypto.verify(null, Buffer.from(canonicalJson, 'utf-8'), key, sig)
  } catch {
    return false
  }
}

// Test / diagnostic helper — read back the public key on disk. Verify path
// uses the DB copy; this is here for the "did keygen write anything?" checks.
export function readPublicKeyOnDisk(operatorId: string): string | null {
  const p = publicKeyPath(operatorId)
  if (!fs.existsSync(p)) return null
  try { return fs.readFileSync(p, 'utf-8').trim() } catch { return null }
}
