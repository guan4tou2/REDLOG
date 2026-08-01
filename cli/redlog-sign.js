#!/usr/bin/env node
// redlog-sign — sign a plugin tarball for the RedLog marketplace registry.
//
// Publishers run this locally after tarring their plugin. It:
//   1. Reads the tarball, computes sha256.
//   2. Signs "sha256:<hexhash>" with an Ed25519 private key.
//   3. Emits a JSON snippet suitable for pasting into the registry index.
//
// Usage:
//   redlog-sign keygen                       -> writes keypair.json (pub/priv b64)
//   redlog-sign sign <tarball> --key <key.json> [--id <plugin-id>] [--version <x.y.z>]
//                                            -> prints the signed index entry
//
// Design intent:
//   - Ed25519 only (spec §5). No knobs.
//   - No network. No touching ~/.redlog. Operator-side utility.
//   - Same trust model as publisher-trust.ts: SPKI b64 public key, base64
//     signature over the ASCII string "sha256:<hexhash>".

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function fail(msg) {
  console.error(`redlog-sign: ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const rest = args.slice(1)
  const positional = []
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
      flags[key] = val
    } else {
      positional.push(a)
    }
  }
  return { cmd, positional, flags }
}

function keygen(flags) {
  const out = flags.out || 'redlog-plugin-keypair.json'
  if (fs.existsSync(out) && !flags.force) fail(`refuse to overwrite ${out} — pass --force to override`)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ format: 'der', type: 'spki' })
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' })
  const record = {
    algorithm: 'ed25519',
    publicKey: pubDer.toString('base64'),
    privateKey: privDer.toString('base64'),
    createdAt: new Date().toISOString(),
    label: flags.label || undefined
  }
  fs.writeFileSync(out, JSON.stringify(record, null, 2), { mode: 0o600 })
  const fpHex = crypto.createHash('sha256').update(pubDer).digest('hex')
  const fp = fpHex.match(/.{2}/g).slice(0, 16).join(':')
  console.log(`wrote keypair → ${out} (mode 0600)`)
  console.log(`publicKey fingerprint: ${fp}`)
  console.log()
  console.log('Share the publicKey field with the RedLog registry maintainer;')
  console.log('keep privateKey local — anyone with it can sign plugins as you.')
}

function sign(positional, flags) {
  const tarballPath = positional[0]
  if (!tarballPath) fail('sign: missing tarball path')
  const keyPath = flags.key
  if (!keyPath) fail('sign: --key <keypair.json> is required')
  if (!fs.existsSync(tarballPath)) fail(`sign: no such file: ${tarballPath}`)
  if (!fs.existsSync(keyPath)) fail(`sign: no such key: ${keyPath}`)

  const bytes = fs.readFileSync(tarballPath)
  const hexHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const message = Buffer.from(`sha256:${hexHash}`, 'utf-8')

  const keypair = JSON.parse(fs.readFileSync(keyPath, 'utf-8'))
  if (keypair.algorithm && keypair.algorithm !== 'ed25519') {
    fail(`sign: unsupported key algorithm: ${keypair.algorithm}`)
  }
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(keypair.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  const signature = crypto.sign(null, message, privKey).toString('base64')

  // Try to sniff id + version from the tarball's plugin.json if the flags
  // weren't supplied. Best-effort — a signer with an unusual tarball layout
  // can still pass them explicitly.
  let id = flags.id
  let version = flags.version
  if ((!id || !version) && !flags['no-sniff']) {
    try {
      const parsed = sniffManifest(tarballPath)
      if (!id) id = parsed?.id
      if (!version) version = parsed?.version
    } catch { /* leave fields blank */ }
  }

  const entry = {
    id: id || '<fill-me>',
    version: version || '<fill-me>',
    publisher: flags.publisher || '<fill-me>',
    tarball: flags.url || '<fill-me: https url to this tarball>',
    sha256: hexHash,
    signature,
    sizeKb: Math.round(bytes.length / 1024)
  }
  if (flags.name) entry.name = flags.name
  if (flags.description) entry.description = flags.description
  if (flags.homepage) entry.homepage = flags.homepage
  if (flags.tags) entry.tags = String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean)

  // Order the keys so the JSON is stable and easy to diff.
  const orderedKeys = ['id', 'name', 'description', 'homepage', 'publisher', 'version', 'tarball', 'sha256', 'signature', 'sizeKb', 'tags']
  const ordered = {}
  for (const k of orderedKeys) if (k in entry) ordered[k] = entry[k]

  console.log(JSON.stringify(ordered, null, 2))
}

// Peek inside a .tar.gz to pull { id, version } out of plugin.json without
// extracting to disk. Falls back gracefully if node's tar isn't around — we
// just use gunzip + streaming tar parse via headers.
function sniffManifest(tarballPath) {
  const zlib = require('zlib')
  const buf = fs.readFileSync(tarballPath)
  const tar = zlib.gunzipSync(buf)
  // Tar block size is 512.
  for (let off = 0; off + 512 <= tar.length;) {
    const nameEnd = tar.indexOf(0, off)
    const name = tar.slice(off, nameEnd < 0 || nameEnd > off + 100 ? off + 100 : nameEnd).toString('utf-8').replace(/\0+$/, '')
    if (!name) break
    // Octal size at offset +124 (12 bytes ASCII).
    const sizeStr = tar.slice(off + 124, off + 136).toString('ascii').trim().replace(/\0/g, '')
    const size = parseInt(sizeStr, 8)
    off += 512
    if (isNaN(size)) break
    if (name.endsWith('plugin.json')) {
      const body = tar.slice(off, off + size).toString('utf-8')
      try { return JSON.parse(body) } catch { return null }
    }
    off += Math.ceil(size / 512) * 512
  }
  return null
}

function help() {
  console.log(`redlog-sign — sign a plugin tarball for the RedLog marketplace.

  keygen [--out <path>] [--label <str>] [--force]
      Generate an Ed25519 keypair. Default: ./redlog-plugin-keypair.json (0600).

  sign <tarball> --key <keypair.json>
                 [--id <plugin-id>] [--version <x.y.z>]
                 [--publisher <slug>] [--url <https url>]
                 [--name <str>] [--description <str>] [--homepage <str>]
                 [--tags foo,bar]
      Print a registry index entry with sha256 + Ed25519 signature.

  help
      This message.`)
}

const { cmd, positional, flags } = parseArgs(process.argv)
switch (cmd) {
  case 'keygen': keygen(flags); break
  case 'sign': sign(positional, flags); break
  case 'help':
  case undefined: help(); break
  default: fail(`unknown command: ${cmd}`)
}
