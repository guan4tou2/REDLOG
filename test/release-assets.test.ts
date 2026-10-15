import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
function candidate(change: (dir: string) => void = () => {}): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'redlog-release-assets-'))
  try {
    const installer = `RedLog.Setup.${version}.exe`
    for (const name of [installer, `RedLog-${version}-arm64.dmg`, `RedLog-${version}-arm64-mac.zip`, `redlog_${version}_amd64.deb`]) {
      writeFileSync(join(dir, name), 'release-candidate')
    }
    const hash = createHash('sha512').update('release-candidate').digest('base64')
    writeFileSync(join(dir, 'latest.yml'), JSON.stringify({ version, path: installer, sha512: hash, files: [{ url: installer, sha512: hash, size: 17 }] }))
    change(dir)
    return spawnSync(process.execPath, [resolve('scripts/verify-release-assets.mjs'), dir], {
      encoding: 'utf8', env: { ...process.env, RELEASE_TAG: `v${version}` }
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('release artifact gate', () => {
  it('accepts the complete installed-package set with matching update metadata', () => {
    const r = candidate()
    expect(r.status, String(r.stderr)).toBe(0)
  })
  it('refuses a release with no Linux installer', () => {
    const r = candidate(dir => rmSync(join(dir, `redlog_${version}_amd64.deb`)))
    expect(r.status).not.toBe(0)
    expect(String(r.stderr)).toContain('Missing release asset')
  })
  it('refuses a retired portable package even when all installers exist', () => {
    const r = candidate(dir => writeFileSync(join(dir, `RedLog.${version}.exe`), 'portable'))
    expect(r.status).not.toBe(0)
    expect(String(r.stderr)).toContain('Unexpected release package')
  })
  it('refuses Windows update metadata after the installer contents change', () => {
    const r = candidate(dir => writeFileSync(join(dir, `RedLog.Setup.${version}.exe`), 'changed-candidate'))
    expect(r.status).not.toBe(0)
    expect(String(r.stderr)).toContain('SHA-512 does not match')
  })
})
