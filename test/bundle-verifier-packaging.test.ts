// A packaged build resolves shipped files under <resources>/; dev and tests
// resolve them from the repo, which masked that tools/redlog-verify.py was
// never packaged — every bundle exported from an installed RedLog shipped
// without its verifier. These pin the packaging side of the contract.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('the evidence-bundle verifier ships in packaged builds', () => {
  it('electron-builder copies tools/redlog-verify.py to <resources>/tools/', () => {
    expect(read('electron-builder.yml')).toMatch(/- from: tools\/redlog-verify\.py\s+to: tools\/redlog-verify\.py/)
  })

  it('the release-only packaged resource check requires it', () => {
    expect(read('scripts/verify-packaged-resources.mjs')).toContain("'tools/redlog-verify.py'")
  })
})
