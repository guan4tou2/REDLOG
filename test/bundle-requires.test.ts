import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// v0.9.6: guards the whole "runtime require survives into the bundle" family.
//
// v0.9.4 P0-4 found one instance: `require('../core/retention')` in
// index.ts. Rollup cannot see through a runtime require, so the module was
// never bundled and the literal call survived into out/main/index.js, where
// it resolved against a non-existent out/core/. Four more turned up in the
// same shape once we went looking — silently disabling anchor-failure
// auditing, orphan-session recovery, and cloud-share's project dir.
//
// Unit tests import the modules directly and so never exercise the bundle.
// This test reads the build output instead: every relative require in
// out/main must point at a file rollup actually emitted.

const OUT = path.join(__dirname, '..', 'out', 'main')
const RELATIVE_REQUIRE = /require\((['"])(\.\.?\/[^'"]+)\1\)/g

const built = fs.existsSync(OUT)

describe.skipIf(!built)('bundle integrity', () => {
  it('every relative require in out/main resolves to an emitted file', () => {
    const unresolved: string[] = []
    for (const file of fs.readdirSync(OUT).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(OUT, file), 'utf-8')
      for (const m of src.matchAll(RELATIVE_REQUIRE)) {
        const target = path.resolve(OUT, m[2])
        if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`)) {
          unresolved.push(`${file} -> ${m[2]}`)
        }
      }
    }
    expect(
      unresolved,
      `Runtime require() that rollup could not bundle — the module is missing ` +
      `from out/ and the call throws MODULE_NOT_FOUND at runtime (usually into ` +
      `a catch, so it fails silently). Use a static import instead:\n` +
      unresolved.map((u) => `  ${u}`).join('\n')
    ).toEqual([])
  })
})
