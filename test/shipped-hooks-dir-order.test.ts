// The hook scripts RedLog installs or sources are found the same way the
// bundle verifier used to be (test/bundle-verifier-path.test.ts): from
// <checkout>/src or <checkout>/out/main, `<__dirname>/../../../hooks` is the
// directory ABOVE the checkout, and trying it first lets whatever sits there
// be installed into the operator's shell instead of the checkout's own hooks.
// The checkout's own (`../../hooks`) is tried first. A packaged build is
// unaffected: app.asar holds only out/ and resources/ (electron-builder.yml),
// so `<resources>/app.asar/hooks` does not exist and the second candidate,
// `<resources>/hooks` from `extraResources`, is used as before.
//
// Neither site has a seam for its directory, so the order is read from the
// source.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
const before = (text: string, first: string, second: string): boolean => {
  const a = text.indexOf(first)
  const b = text.indexOf(second)
  if (a < 0 || b < 0) throw new Error(`not found: ${a < 0 ? first : second}`)
  return a < b
}

describe('the checkout\'s own hooks are tried before the directory above it', () => {
  it('terminal-manager resolveShellHook', () => {
    const src = read('src/main/terminal-manager.ts')
    const body = src.slice(src.indexOf('function resolveShellHook'), src.indexOf('function resolveShellHook') + 600)
    expect(before(body, "path.join(__dirname, '../../hooks')", "path.join(__dirname, '../../../hooks')")).toBe(true)
  })

  it('hooks-manager srcPathForRelative', () => {
    const src = read('src/core/hooks-manager.ts')
    expect(src).toMatch(/resolveDir\(join\(__dirname, '\.\.\/\.\.\/hooks'\), HOOKS_DIR\)/)
  })
})
