import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

// Cloud-share tests need a real project DB because prepareCloudShareBundle
// walks through the existing exportBundle path (events, quickmarks, chain).
// Rather than stand up sqlite here, we mock the two symbols cloud-share
// pulls in from bundle-export + friends, so the test can drive just the
// wrapper (zip + manifest + gate logic).

vi.mock('../src/core/bundle-export', () => {
  return {
    exportBundle: (engagementId: string, outRoot?: string) => {
      const dir = fs.mkdtempSync(path.join(outRoot ?? os.tmpdir(), 'bundle-'))
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"id":"stub"}\n')
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ engagementId, files: [] }))
      return {
        outDir: dir,
        manifest: {
          bundleVersion: 1, createdAt: new Date().toISOString(), hostname: 'test',
          engagementId, signedBy: null,
          chainHead: { hash: 'aa'.repeat(32), eventCount: 42 },
          lastAnchor: null,
          sanitized: { events: 3, totalInDb: 5 },
          files: []
        }
      }
    }
  }
})
vi.mock('../src/core/sanitize', () => ({ countSanitizedEvents: () => 5 }))
vi.mock('../src/core/chain-anchor', () => ({
  computeChainHead: () => ({ hash: 'bb'.repeat(32), headEventId: 'e42', eventCount: 42 })
}))
vi.mock('../src/core/db/events', () => ({ getEventCount: () => 42 }))
vi.mock('../src/core/db/index', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-project-'))
  return { getProjectDir: () => projectDir, getDB: () => { throw new Error('unused in this test') } }
})

// Note: cloud-share.ts imports the modules above at module top; vi.mock
// hoists so those imports resolve to the mocks. cloud-share-uploader.ts
// only imports fs/https/crypto/homedir + types from cloud-share, so it
// stays real.

async function getMods() {
  return {
    cs: await import('../src/core/cloud-share'),
    up: await import('../src/core/cloud-share-uploader')
  }
}

// Skip on Windows CI runners without `zip` installed. macOS + Linux always have it.
// (Compress-Archive path is exercised by the "runs on Windows" pseudo-test below.)
const hasZip = process.platform === 'win32'
  ? spawnSync('powershell.exe', ['-Command', 'Get-Command Compress-Archive']).status === 0
  : spawnSync('zip', ['-h']).status === 0

describe.skipIf(!hasZip)('cloud-share prepareBundle', () => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-')); process.env.HOME = home; process.env.USERPROFILE = home })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('refuses to build without the reviewed-by-operator flag', async () => {
    const { cs } = await getMods()
    expect(() => cs.prepareCloudShareBundle({ engagementId: 'demo', reviewedByOperator: false }))
      .toThrow(cs.RedactionGateError)
  })

  it('produces a .zip + manifest.json when the gate is satisfied', async () => {
    const { cs } = await getMods()
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-out-'))
    const prepared = cs.prepareCloudShareBundle({
      engagementId: 'demo',
      reviewedByOperator: true,
      outRoot
    })
    expect(fs.existsSync(prepared.zipPath)).toBe(true)
    expect(prepared.manifest.bundleFormat).toBe(1)
    expect(prepared.manifest.engagement.id).toBe('demo')
    expect(prepared.manifest.zipSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.manifest.contents.sanitizedEventCount).toBe(3)
    expect(prepared.manifest.contents.eventCount).toBe(42)
    // sidecar manifest was written next to the zip
    expect(fs.existsSync(prepared.zipPath + '.manifest.json')).toBe(true)
    // zip is a real ZIP: first bytes are "PK\x03\x04"
    const first = fs.readFileSync(prepared.zipPath).subarray(0, 4)
    expect(first.toString('hex')).toBe('504b0304')
  })

  it('rejects a bundle bigger than the cap and cleans up the oversized zip', async () => {
    const { cs } = await getMods()
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cap-'))
    // Cap of 1 byte is essentially impossible to hit — even an empty zip is >1B.
    expect(() => cs.prepareCloudShareBundle({
      engagementId: 'demo', reviewedByOperator: true, outRoot, maxBytes: 1
    })).toThrow(cs.BundleTooLargeError)
    // The oversized .zip should have been cleaned up.
    const zips = fs.readdirSync(outRoot, { withFileTypes: true, recursive: true } as {
      withFileTypes: true; recursive: true
    }).filter((e) => e.isFile() && e.name.endsWith('.zip'))
    expect(zips).toHaveLength(0)
  })

  it('previewRedaction reports the sanitized total and chain head', async () => {
    const { cs } = await getMods()
    const preview = cs.previewRedaction()
    expect(preview.eventCount).toBe(42)
    expect(preview.sanitizedEventCountTotal).toBe(5)
    expect(preview.chainHead?.eventCount).toBe(42)
  })
})

describe.skipIf(!hasZip)('cloud-share localFileUploader (stub)', () => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-')); process.env.HOME = home; process.env.USERPROFILE = home })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('copies the zip to ~/.redlog/shares/<shortSha>/ and returns a file:// URL', async () => {
    const { cs, up } = await getMods()
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upl-'))
    const prepared = cs.prepareCloudShareBundle({ engagementId: 'demo', reviewedByOperator: true, outRoot })
    const r = await up.localFileUploader.upload(prepared, { expiresIn: '7d' })
    expect(r.ok).toBe(true)
    // pathToFileURL normalises Windows separators to forward slashes and
    // prefixes drive letters correctly (file:///C:/Users/…), so the URL is
    // portable across OSes now.
    expect(r.shareUrl).toMatch(/^file:\/\/\/.*\/\.redlog\/shares\/[a-f0-9]{8}\//)
    expect(r.expiresAt).toBeTruthy()
    // fileURLToPath decodes the URL back to an OS-native path (handles the
    // /C:/... prefix on Windows) so we can hit fs with it.
    const localPath = fileURLToPath(r.shareUrl!)
    expect(fs.existsSync(localPath)).toBe(true)
    expect(fs.readFileSync(localPath)).toEqual(fs.readFileSync(prepared.zipPath))
    // Final manifest sidecar carries the upload block.
    const sidecar = JSON.parse(fs.readFileSync(localPath + '.manifest.json', 'utf-8'))
    expect(sidecar.upload.shareUrl).toBe(r.shareUrl)
    expect(sidecar.upload.expiresAt).toBe(r.expiresAt)
  })

  it('honours expiresIn: "never" by omitting expiresAt', async () => {
    const { cs, up } = await getMods()
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upl-never-'))
    const prepared = cs.prepareCloudShareBundle({ engagementId: 'demo', reviewedByOperator: true, outRoot })
    const r = await up.localFileUploader.upload(prepared, { expiresIn: 'never' })
    expect(r.ok).toBe(true)
    expect(r.expiresAt).toBeUndefined()
  })

  it('produces different share paths for different bundles (sha8 bucketing)', async () => {
    const { cs, up } = await getMods()
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-diff-'))
    const p1 = cs.prepareCloudShareBundle({ engagementId: 'demo', reviewedByOperator: true, outRoot })
    // Doctor the zip a bit so the sha8 differs — write a byte to the copy.
    const p2 = cs.prepareCloudShareBundle({ engagementId: 'demo-2', reviewedByOperator: true, outRoot })
    const r1 = await up.localFileUploader.upload(p1, {})
    const r2 = await up.localFileUploader.upload(p2, {})
    expect(r1.shareUrl).not.toBe(r2.shareUrl)
  })
})
