// Spec 072 T006 — the renderer-purity half of `registry-pure` (FR-022).
//
// The registry (src/core/kinds/, Phase 2) is read by the renderer, so it may
// import no Node module and nothing outside its directory (FR-020). That first
// half is written with the module, in Phase 2. This half exists now because it
// measures something that is already true and that the registry's placement
// depends on: how many `src/core` files the renderer already pulls in AT RUN
// TIME that themselves import a Node module. Today three do — they ride along
// into the browser bundle as "externalized for browser compatibility" stubs.
//
// Ratchet: the number may go down, never up. To lower it, stop the renderer
// reaching the file (move the pure part out, or make the import type-only) and
// lower BASELINE in the same change. A new file that raises it fails, with the
// chain from the renderer file that reaches it.
//
// What counts: a non-type, relative import path from any file under
// src/renderer/src to a file under src/core whose own non-type imports include
// a Node built-in (`fs`, `node:path`, …). See renderer-core-walk.ts.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import glob from 'fast-glob'
import { nodeImportsOf, reach } from './renderer-core-walk'

const ROOT = path.join(__dirname, '..', '..')

// Counted 2026-11-13 on origin/main c27ed558: config.ts, private-fs.ts,
// agent-capture-policy.ts — the spec's three, and no others.
const BASELINE = 3

function offenders(): Array<{ file: string; node: string[]; via: string }> {
  const entries = glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true, ignore: ['**/*.d.ts'] })
  const reached = reach(entries)
  const core = path.join(ROOT, 'src', 'core') + path.sep
  const out: Array<{ file: string; node: string[]; via: string }> = []
  for (const [file, chain] of reached) {
    if (!file.startsWith(core)) continue
    const node = nodeImportsOf(file)
    if (node.length === 0) continue
    out.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), node, via: chain.map((c) => path.relative(ROOT, c).split(path.sep).join('/')).join(' -> ') })
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1))
}

describe('registry-pure, second half: the renderer reaches Node through src/core', () => {
  it('imports no more Node-importing core files than the recorded baseline', () => {
    const found = offenders()
    const message = `${found.length} (baseline ${BASELINE}):\n${found.map((o) => `${o.file} imports ${o.node.join(', ')}\n    reached: ${o.via}`).join('\n')}`
    expect(found.length, message).toBeLessThanOrEqual(BASELINE)
  })

  it('and the baseline is not stale: lower it when one is fixed', () => {
    expect(offenders().length).toBe(BASELINE)
  })
})
