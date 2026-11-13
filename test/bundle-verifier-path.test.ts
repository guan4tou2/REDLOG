// Every evidence bundle carries the offline verifier, read from wherever
// findBundleVerifier says. It used to try `<__dirname>/../../../tools` first:
// from <checkout>/src/core or <checkout>/out/main that is the directory ABOVE
// the checkout, so any tools/redlog-verify.py there shadowed the repository's
// own and was shipped inside the bundle. It happened: an older verifier sitting
// beside a worktree went into three committed goldens, and CI, with the
// repository's verifier, disagreed with every one of them.
//
// The layouts (electron-builder.yml): a packaged build runs from
// <resources>/app.asar/out/main, and `extraResources` puts the verifier at
// <resources>/tools/redlog-verify.py; app.asar itself holds only out/ and
// resources/. A source run (vitest: src/core) and the dev or built app
// (electron-vite: out/main) are two levels below the checkout.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findBundleVerifier } from '../src/core/bundle-verifier-path'

let root = ''
const put = (rel: string, text: string): string => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

describe('the verifier a bundle ships is the one beside the code, never one above the checkout', () => {
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-verifier-path-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const codeDir of ['src/core', 'out/main']) {
    it(`a checkout (code in ${codeDir}) uses <checkout>/tools, not a decoy in the checkout's parent`, () => {
      put('tools/redlog-verify.py', '# decoy above the checkout\n')
      const own = put('checkout/tools/redlog-verify.py', '# the repository\'s\n')
      expect(findBundleVerifier(path.join(root, 'checkout', codeDir))).toBe(own)
    })
  }

  it('a checkout without its verifier fails, naming the one place it looked; it does not take the decoy above', () => {
    put('tools/redlog-verify.py', '# decoy above the checkout\n')
    fs.mkdirSync(path.join(root, 'checkout', 'src', 'core'), { recursive: true })
    expect(() => findBundleVerifier(path.join(root, 'checkout', 'src', 'core')))
      .toThrow(`missing tools/redlog-verify.py. Tried: ${path.join(root, 'checkout', 'tools', 'redlog-verify.py')}`)
  })

  it('a packaged build (code in <resources>/app.asar/out/main) uses <resources>/tools', () => {
    const shipped = put('Resources/tools/redlog-verify.py', '# packaged\n')
    put('tools/redlog-verify.py', '# decoy above Resources\n')
    expect(findBundleVerifier(path.join(root, 'Resources', 'app.asar', 'out', 'main'))).toBe(shipped)
  })
})
