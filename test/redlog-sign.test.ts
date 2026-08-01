import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, execSync } from 'child_process'
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto'
import zlib from 'zlib'

// Drive the CLI as an external process — that's the surface publishers use, so
// tests that go through node's child_process catch flag-parsing regressions
// the way an in-process require() call would miss.

const CLI = path.resolve(__dirname, '..', 'cli', 'redlog-sign.js')

function run(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8', timeout: 20_000 })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

/** Build a minimum-viable .tar.gz with a single plugin.json entry inside. */
function makeTarball(dir: string, manifest: object): string {
  const tarPath = path.join(dir, 'plugin.tar.gz')
  const body = Buffer.from(JSON.stringify(manifest, null, 2))
  // Build a tar header (POSIX ustar) for `plugin/plugin.json`, then pad to 512.
  const header = Buffer.alloc(512, 0)
  const name = 'plugin/plugin.json'
  Buffer.from(name).copy(header, 0)
  Buffer.from('0000644\0').copy(header, 100)
  Buffer.from('0000000\0').copy(header, 108)
  Buffer.from('0000000\0').copy(header, 116)
  Buffer.from(body.length.toString(8).padStart(11, '0') + '\0').copy(header, 124)
  Buffer.from('00000000000\0').copy(header, 136)
  Buffer.from('        ').copy(header, 148)   // checksum placeholder
  header.write('0', 156)
  Buffer.from('ustar\000').copy(header, 257)
  Buffer.from('00').copy(header, 263)
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += header[i]
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148)

  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0)
  body.copy(padded, 0)
  const trailer = Buffer.alloc(1024, 0)   // two zero blocks marks EOF
  const uncompressed = Buffer.concat([header, padded, trailer])
  const gz = zlib.gzipSync(uncompressed)
  fs.writeFileSync(tarPath, gz)
  return tarPath
}

describe('redlog-sign CLI', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-sign-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('help exits 0 and prints usage', () => {
    const r = run(['help'], dir)
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/keygen/)
    expect(r.stdout).toMatch(/sign/)
  })

  it('keygen writes a keypair with a valid SPKI public key', () => {
    const r = run(['keygen', '--out', 'kp.json'], dir)
    expect(r.code).toBe(0)
    const keypair = JSON.parse(fs.readFileSync(path.join(dir, 'kp.json'), 'utf-8'))
    expect(keypair.algorithm).toBe('ed25519')
    // The public key should parse as an SPKI Ed25519 key.
    const key = createPublicKey({
      key: Buffer.from(keypair.publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    })
    expect(key.asymmetricKeyType).toBe('ed25519')
    // File mode should be 0600 (owner-only).
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(dir, 'kp.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('keygen refuses to overwrite an existing keypair unless --force', () => {
    fs.writeFileSync(path.join(dir, 'kp.json'), 'existing')
    const r = run(['keygen', '--out', 'kp.json'], dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/refuse/)
  })

  it('sign produces a signature that verifies with the paired public key', () => {
    // keygen → build tarball → sign → verify
    run(['keygen', '--out', 'kp.json'], dir)
    const tarball = makeTarball(dir, { id: 'demo', version: '1.0.0', redlogApi: 1, name: 'x', contributes: {} })
    const r = run(['sign', tarball, '--key', 'kp.json', '--publisher', 'gutou'], dir)
    expect(r.code).toBe(0)
    const entry = JSON.parse(r.stdout)
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(entry.signature).toBeTruthy()

    const keypair = JSON.parse(fs.readFileSync(path.join(dir, 'kp.json'), 'utf-8'))
    const pub = createPublicKey({
      key: Buffer.from(keypair.publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    })
    const ok = cryptoVerify(
      null,
      Buffer.from(`sha256:${entry.sha256}`, 'utf-8'),
      pub,
      Buffer.from(entry.signature, 'base64')
    )
    expect(ok).toBe(true)
  })

  it('sign sniffs plugin.json id + version from the tarball when not passed', () => {
    run(['keygen', '--out', 'kp.json'], dir)
    const tarball = makeTarball(dir, { id: 'sniffed', version: '2.3.4', redlogApi: 1, name: 'sniff-me', contributes: {} })
    const r = run(['sign', tarball, '--key', 'kp.json'], dir)
    expect(r.code).toBe(0)
    const entry = JSON.parse(r.stdout)
    expect(entry.id).toBe('sniffed')
    expect(entry.version).toBe('2.3.4')
  })

  it('sign includes optional flags (name, description, tags) in the output entry', () => {
    run(['keygen', '--out', 'kp.json'], dir)
    const tarball = makeTarball(dir, { id: 'demo', version: '1.0.0', redlogApi: 1, name: 'x', contributes: {} })
    const r = run([
      'sign', tarball, '--key', 'kp.json',
      '--publisher', 'gutou',
      '--name', 'Demo Plugin',
      '--description', 'does the demo',
      '--tags', 'a,b,c'
    ], dir)
    expect(r.code).toBe(0)
    const entry = JSON.parse(r.stdout)
    expect(entry.name).toBe('Demo Plugin')
    expect(entry.description).toBe('does the demo')
    expect(entry.tags).toEqual(['a', 'b', 'c'])
  })

  it('sign errors out gracefully when the tarball is missing', () => {
    run(['keygen', '--out', 'kp.json'], dir)
    const r = run(['sign', 'nonexistent.tgz', '--key', 'kp.json'], dir)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/no such file/)
  })
})
