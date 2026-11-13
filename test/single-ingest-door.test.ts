// Spec 071 T006: `ingest()` is meant to be the one door into the record, and
// today it is not. Production code still calls the DB primitive `insertEvent(`
// directly — every such row skips the pipeline (causes, enrichment, redaction
// spans, publish) and, after Spec 071, will skip the ingest stamp as well.
//
// This is a ratchet over those calls, in the shape of test/mutation-guard.test.ts:
// the count may go down, never up. T037 migrates them one file group at a time
// and lowers DIRECT_BASELINE in the same change; T038 takes it to 0.
//
// What is counted: every `insertEvent(` in src/** outside two places —
//   - src/core/db/event-write.ts, which defines it (and names it in a comment
//     and an error string);
//   - the single call inside src/core/ingest.ts, which IS the door.
// Comment lines are skipped. An alias (`const w = insertEvent`) or a call
// through a namespace import (`events.insertEvent(`) is still a match for
// the latter, not for the former; there are none of either today.
//
// test/canonical-ingest-sources.test.ts is kept beside this one: it also bars
// `eventBus.publish(` from the capture sources, which this test does not
// count, and it fails on any call in those files rather than on a total.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Counted 2026-11-12 on origin/main 7b2ce3d2: 31 call sites in 14 files.
// The spec's table says 30; bundle-export.ts has two calls, not one.
// Lowered to 30 on 2026-11-13 at main 5b4d67b0: #734 folded two calls in
// src/main/index.ts into one and left this at 31, which let one new direct
// call through unnoticed. Lower it in the change that removes a call.
const DIRECT_BASELINE = 30

const DEFINITION = 'src/core/db/event-write.ts'
const DOOR = 'src/core/ingest.ts'
const CALL = /\binsertEvent\s*\(/g

function directCalls(): string[] {
  const out: string[] = []
  for (const file of glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    if (rel === DEFINITION) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      for (const _ of line.matchAll(CALL)) out.push(`${rel}:${i + 1}`)
    })
  }
  return out
}

describe('the single ingest door', () => {
  it('ingest.ts calls insertEvent exactly once — that call is the door', () => {
    const inDoor = directCalls().filter((c) => c.startsWith(`${DOOR}:`))
    expect(inDoor, inDoor.join('\n')).toHaveLength(1)
  })

  it('direct insertEvent calls outside ingest do not grow past the recorded baseline', () => {
    const found = directCalls().filter((c) => !c.startsWith(`${DOOR}:`))
    expect(found.length, `direct insertEvent calls now ${found.length} (baseline ${DIRECT_BASELINE}):\n${found.join('\n')}`)
      .toBeLessThanOrEqual(DIRECT_BASELINE)
  })
})
