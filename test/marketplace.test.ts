import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto'

// Same HOME-swap pattern as publisher-trust.test — plus a stub tar extractor
// so tests never shell out to /usr/bin/tar.
//
// The marketplace module uses opts.extractTar to let us hand it a plugin
// directory synthesized in-process. That means we can drive the whole
// install → validate → snapshot → rollback flow without touching tarballs.

async function withTempHome<T>(fn: (mods: {
  marketplace: typeof import('../src/core/plugins/marketplace')
  publisherTrust: typeof import('../src/core/plugins/publisher-trust')
}) => Promise<T>): Promise<T> {
  // Windows resolves os.homedir() via USERPROFILE, POSIX via HOME — swap both
  // or Windows tests leak the operator's real ~/.redlog into every case.
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-mp-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  vi.resetModules()
  // publisher-trust must be imported BEFORE marketplace so the marketplace
  // module's own `import { verifySignature } from './publisher-trust'` binds
  // to the same singleton the test drives directly.
  const publisherTrust = await import('../src/core/plugins/publisher-trust')
  const marketplace = await import('../src/core/plugins/marketplace')
  try {
    return await fn({ marketplace, publisherTrust })
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey
  }
}

// Build a fake "tarball body" as a JS object the stub extractor will unpack.
// The actual bytes we pass to installFromRegistry don't matter for validation
// beyond hash-matching — the stub extractor materialises the manifest.
function buildPluginBundle(manifest: object): { bytes: Buffer; sha256: string; extract: (_buf: Buffer, dest: string) => Promise<void> } {
  const bytes = Buffer.from(JSON.stringify(manifest))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const extract = async (_buf: Buffer, dest: string): Promise<void> => {
    fs.writeFileSync(path.join(dest, 'plugin.json'), JSON.stringify(manifest, null, 2))
  }
  return { bytes, sha256, extract }
}

describe('marketplace revocation', () => {
  it('refuses install of a plugin listed on the revocation list', async () => {
    await withTempHome(async ({ marketplace }) => {
      const revPath = path.join(process.env.HOME!, '.redlog', 'plugins', 'revocations.json')
      fs.mkdirSync(path.dirname(revPath), { recursive: true })
      fs.writeFileSync(revPath, JSON.stringify({ updatedAt: 1, plugins: ['baddy'] }))

      const bundle = buildPluginBundle({ id: 'baddy', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
      const result = await marketplace.installFromRegistry({
        id: 'baddy', name: 'x', publisher: 'p', version: '1.0.0',
        tarball: 'https://example.com/x.tgz', sha256: bundle.sha256
      }, { extractTar: bundle.extract, fetchTarball: async () => bundle.bytes })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/revoked/)
    })
  })

  it('refuses install of any plugin from a revoked publisher', async () => {
    await withTempHome(async ({ marketplace }) => {
      const revPath = path.join(process.env.HOME!, '.redlog', 'plugins', 'revocations.json')
      fs.mkdirSync(path.dirname(revPath), { recursive: true })
      fs.writeFileSync(revPath, JSON.stringify({ updatedAt: 1, publishers: ['naughty-inc'] }))

      const bundle = buildPluginBundle({ id: 'goody', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
      const result = await marketplace.installFromRegistry({
        id: 'goody', name: 'x', publisher: 'naughty-inc', version: '1.0.0',
        tarball: 'https://example.com/x.tgz', sha256: bundle.sha256
      }, { extractTar: bundle.extract, fetchTarball: async () => bundle.bytes })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/naughty-inc/)
    })
  })
})

describe('marketplace signature enforcement', () => {
  it('rejects a privileged plugin that has no signature', async () => {
    await withTempHome(async ({ marketplace }) => {
      const manifest = {
        id: 'evil', name: 'x', version: '1.0.0', redlogApi: 1,
        contributes: { mcpTools: 'code/mcp.js' }   // makes it privileged
      }
      // Provide the mcp.js file so validateManifest doesn't fail on that.
      const extract = async (_buf: Buffer, dest: string): Promise<void> => {
        fs.writeFileSync(path.join(dest, 'plugin.json'), JSON.stringify(manifest))
        fs.mkdirSync(path.join(dest, 'code'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'code', 'mcp.js'), '// stub')
      }
      const bytes = Buffer.from('anything')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const spy = vi.spyOn(marketplace as unknown as Record<string, unknown>, 'installFromRegistry')  // no-op — just to ensure it exists
      spy.mockRestore()

      const result = await marketplace.installFromRegistry({
        id: 'evil', name: 'x', publisher: 'unknown', version: '1.0.0',
        tarball: 'https://x/x.tgz', sha256
        // no signature
      }, { extractTar: extract, fetchTarball: async () => bytes })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/privileged plugin without a verified/)
    })
  })

  it('accepts a signed privileged plugin from a trusted publisher', async () => {
    await withTempHome(async ({ marketplace, publisherTrust }) => {
      const kp = makeKeypair()
      publisherTrust.trustPublisher('gutou', { publicKey: kp.publicKey, trustedAt: 1 })

      const manifest = {
        id: 'signed-priv', name: 'x', version: '1.0.0', redlogApi: 1,
        publisher: 'gutou',
        contributes: { mcpTools: 'code/mcp.js' }
      }
      const extract = async (_buf: Buffer, dest: string): Promise<void> => {
        fs.writeFileSync(path.join(dest, 'plugin.json'), JSON.stringify(manifest))
        fs.mkdirSync(path.join(dest, 'code'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'code', 'mcp.js'), '// stub')
      }
      const bytes = Buffer.from('doesnt-matter-for-hash-check')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const sig = cryptoSign(null, Buffer.from(`sha256:${sha256}`, 'utf-8'), kp.privateKey).toString('base64')

      const result = await marketplace.installFromRegistry({
        id: 'signed-priv', name: 'x', publisher: 'gutou', version: '1.0.0',
        tarball: 'https://x/x.tgz', sha256, signature: sig
      }, { extractTar: extract, fetchTarball: async () => bytes })

      expect(result.ok).toBe(true)
      expect(result.tier).toBe('privileged')
      expect(result.signatureVerified).toBe(true)
      // Rollback snapshot didn't happen — this was a fresh install.
      expect(result.rolledBackFrom).toBeUndefined()
    })
  })

  it('accepts an unsigned declarative plugin', async () => {
    await withTempHome(async ({ marketplace }) => {
      const bundle = buildPluginBundle({
        id: 'declar', name: 'x', version: '1.0.0', redlogApi: 1,
        contributes: { lootPatterns: [{ type: 'foo', pattern: '\\bfoo\\b' }] }
      })
      const result = await marketplace.installFromRegistry({
        id: 'declar', name: 'x', publisher: 'anyone', version: '1.0.0',
        tarball: 'https://x/x.tgz', sha256: bundle.sha256
      }, { extractTar: bundle.extract, fetchTarball: async () => bundle.bytes })
      expect(result.ok).toBe(true)
      expect(result.tier).toBe('declarative')
      expect(result.signatureVerified).toBe(false)
    })
  })
})

describe('marketplace hash + metadata gates', () => {
  it('refuses install when the tarball sha256 differs from the registry entry', async () => {
    await withTempHome(async ({ marketplace }) => {
      const bundle = buildPluginBundle({ id: 'x', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
      const result = await marketplace.installFromRegistry({
        id: 'x', name: 'x', publisher: 'p', version: '1.0.0',
        tarball: 'https://x/x.tgz',
        sha256: '0'.repeat(64) // wrong
      }, { extractTar: bundle.extract, fetchTarball: async () => bundle.bytes })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/sha256 mismatch/)
    })
  })

  it('refuses install when the tarball manifest id disagrees with the registry entry', async () => {
    await withTempHome(async ({ marketplace }) => {
      const bundle = buildPluginBundle({ id: 'liar', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
      const result = await marketplace.installFromRegistry({
        id: 'expected-id', name: 'x', publisher: 'p', version: '1.0.0',
        tarball: 'https://x/x.tgz', sha256: bundle.sha256
      }, { extractTar: bundle.extract, fetchTarball: async () => bundle.bytes })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/id mismatch/)
    })
  })
})

describe('marketplace rollback', () => {
  it('snapshots the previous version and rollback restores it', async () => {
    await withTempHome(async ({ marketplace }) => {
      // First install: version 1.0.0
      const b1 = buildPluginBundle({ id: 'demo', name: 'x', version: '1.0.0', redlogApi: 1, contributes: {} })
      const r1 = await marketplace.installFromRegistry({
        id: 'demo', name: 'x', publisher: 'p', version: '1.0.0',
        tarball: 'https://x/x.tgz', sha256: b1.sha256
      }, { extractTar: b1.extract, fetchTarball: async () => b1.bytes })
      expect(r1.ok).toBe(true)
      const installed = r1.installedDir!
      // Write a marker file so we can detect which version is live after rollback.
      fs.writeFileSync(path.join(installed, 'VERSION_MARKER'), 'v1')

      // Second install: version 1.1.0 — should snapshot v1 into a versions dir.
      const b2 = buildPluginBundle({ id: 'demo', name: 'x', version: '1.1.0', redlogApi: 1, contributes: {} })
      const r2 = await marketplace.installFromRegistry({
        id: 'demo', name: 'x', publisher: 'p', version: '1.1.0',
        tarball: 'https://x/x.tgz', sha256: b2.sha256
      }, { extractTar: b2.extract, fetchTarball: async () => b2.bytes })
      expect(r2.ok).toBe(true)
      expect(r2.rolledBackFrom).toBeTruthy()
      // Live install is now v1.1.0 (VERSION_MARKER is gone).
      expect(fs.existsSync(path.join(installed, 'VERSION_MARKER'))).toBe(false)

      // The versions dir should now hold one snapshot.
      const versions = marketplace.listVersions('demo')
      expect(versions.length).toBeGreaterThan(0)

      // Roll back to the snapshot — the VERSION_MARKER should reappear.
      const roll = marketplace.rollback('demo', versions[0])
      expect(roll.ok).toBe(true)
      expect(fs.readFileSync(path.join(installed, 'VERSION_MARKER'), 'utf-8')).toBe('v1')
    })
  })
})
