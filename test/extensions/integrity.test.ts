// Spec 076 T007 (US4, plan "它取代什麼" #2): the content hash a plugin's trust
// grant is pinned to covers the manifest and the files it names as `hookFile`
// or `tailers` — and nothing else in the plugin folder.
//
// plugins/c2-tailers shows what that leaves out. Its manifest names two shell
// wrappers (hooks/sliver-tail.sh, hooks/generic-tail.sh); the code that does
// the work, c2-tail.js, parse.js and follow.js, is only `require`d by those
// wrappers, so it is not in the hash. Change one byte of parse.js and
// `computeContentHash` returns the value it returned before: an update that
// swaps the parser keeps its approval (manifest.ts:308-323).
//
// Two tests hold that down:
//   - the control: a byte changed in a file the manifest DOES name moves the
//     hash, so "the hash did not move" in the next test cannot be a hash that
//     never moves at all;
//   - the defect, written as the correct behaviour and marked `it.fails`: a
//     byte changed in parse.js must change the hash. It fails today for exactly
//     that assertion. Spec 076 Phase 2 (`core/extensions/integrity.ts` hashing
//     every file in `files`) makes it pass, and the marker comes off then.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { validateManifest, computeContentHash } from '../../src/core/plugins/manifest'

const SOURCE = path.join(__dirname, '..', '..', 'plugins', 'c2-tailers')

/** A copy of the bundled plugin, hashed after `mutate` has changed it. */
function hashAfter(mutate: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-integrity-'))
  try {
    fs.cpSync(SOURCE, dir, { recursive: true })
    mutate(dir)
    const parsed = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), dir)
    if (!parsed.ok || !parsed.manifest) throw new Error(`c2-tailers did not validate: ${parsed.error}`)
    return computeContentHash(parsed.manifest, dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** One byte appended: the smallest change there is. */
const touch = (file: string) => (dir: string): void => fs.appendFileSync(path.join(dir, file), '\n')

describe('plugin content hash (Spec 076 T007)', () => {
  it('is stable for the same bytes', () => {
    expect(hashAfter(() => undefined)).toBe(hashAfter(() => undefined))
  })

  it('control: a byte changed in a file the manifest names (hooks/sliver-tail.sh) changes the hash', () => {
    expect(hashAfter(touch('hooks/sliver-tail.sh'))).not.toBe(hashAfter(() => undefined))
  })

  it('today a byte changed in plugins/c2-tailers/parse.js does NOT change the hash (the defect, as it is)', () => {
    expect(hashAfter(touch('parse.js'))).toBe(hashAfter(() => undefined))
  })

  // Correct behaviour: code that runs under an approval is covered by it. The
  // pin above states the same fact as it is today; both go in Phase 2.
  it.fails('a byte changed in plugins/c2-tailers/parse.js changes the hash', () => {
    expect(hashAfter(touch('parse.js'))).not.toBe(hashAfter(() => undefined))
  })
})
