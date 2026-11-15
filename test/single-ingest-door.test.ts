// Spec 071 T006: `ingest()` is meant to be the one door into the record, and
// today it is not. Production code still calls the DB primitive `insertEvent(`
// directly, and beside most of those calls a hand-written `eventBus.publish(`.
//
// What a directly written row skips is the policy around the write, not the
// stamp (`insertEvent` stamps `_ingest` itself, test/ingest-stamp.test.ts):
//   - the engagement check made BEFORE enrichment (insertEvent makes it too,
//     but only after the open project's sidecars could already have been
//     written);
//   - causal links, target extraction, technique tags, loot scanning and
//     redaction spans — all no-ops for `system`, `marker` and `loot` rows, but
//     a direct call is the same bypass for any other type;
//   - the one publish, which `ingest()` makes after the commit: a direct call
//     has to write its own, and three of them (session_start, opsec_airgap,
//     anchor_failed) have none, so those rows never reach a live subscriber;
//   - the post-commit steps (scope dispatch, companions) and error wrapping
//     (`committedEventOf`).
//
// This is a ratchet over those calls, in the shape of test/mutation-guard.test.ts:
// a count may go down, never up. T037 migrates them one file group at a time;
// T038 takes every entry to 0.
//
// The counts are per file and asserted for EXACT equality, so two migrations
// running in parallel do not fight over one total. Each map has one entry per
// line with a blank line between entries: two branches that change different
// entries merge without a conflict (adjacent changed lines conflict, lines
// separated by an unchanged line do not). A migration sets its own entries to
// 0 and NEVER deletes a line — a deleted entry and a file that gained a call
// would be indistinguishable from "not in the map".
//
// What is counted: every `insertEvent(` and every `eventBus.publish(` in
// src/** outside
//   - src/core/db/event-write.ts, which defines `insertEvent` (it names it in
//     a comment and an error string; it has no publish);
//   - the one call of each inside src/core/ingest.ts, which IS the door.
// Comment lines are skipped. An alias (`const w = insertEvent`) or a call
// through a namespace import (`events.insertEvent(`) is still a match for
// `insertEvent(`; there are none of either today. A file that is in neither
// map must have none.
//
// test/canonical-ingest-sources.test.ts is kept beside this one: it bars both
// calls from the capture sources, in every file there, rather than counting.
// test/in-process-door-equivalence.test.ts shows that moving a call here to
// the door leaves the stored row as it was.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Counted 2026-11-15 on main fb93bd83: 30 direct calls in 13 files and 25
// hand-written publishes in 11 (the spec's table numbers the calls #1-#30).
// Three of the calls (session_start, opsec_airgap, anchor_failed) have no
// publish beside them at all.
const DIRECT_INSERT: Record<string, number> = {
  'src/core/alert/surface.ts': 1,

  'src/core/bundle-export.ts': 2,

  'src/core/chain-anchor.ts': 1,

  'src/core/export-direct-bundle.ts': 1,

  'src/core/loot-detector.ts': 1,

  'src/core/marker-amend.ts': 1,

  'src/core/retention.ts': 0,

  'src/core/sanitize.ts': 1,

  'src/core/scope-recompute-run.ts': 3,

  'src/core/update-anchor.ts': 2,

  'src/main/index.ts': 10,

  'src/main/ipc/markers.ts': 1,

  'src/main/ipc/plugins.ts': 1
}

const HAND_PUBLISH: Record<string, number> = {
  'src/core/alert/surface.ts': 1,

  'src/core/bundle-export.ts': 2,

  'src/core/export-direct-bundle.ts': 1,

  'src/core/loot-detector.ts': 1,

  'src/core/retention.ts': 0,

  'src/core/sanitize.ts': 1,

  'src/core/scope-recompute-run.ts': 1,

  'src/core/update-anchor.ts': 2,

  'src/main/index.ts': 8,

  'src/main/ipc/markers.ts': 2,

  'src/main/ipc/plugins.ts': 1
}

const DEFINITION = 'src/core/db/event-write.ts'
const DOOR = 'src/core/ingest.ts'
const INSERT_CALL = /\binsertEvent\s*\(/g
const PUBLISH_CALL = /\beventBus\.publish\s*\(/g

/** `file:line` of every call matching `call`, per file (comment lines skipped). */
function callsByFile(call: RegExp, skip: (rel: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    if (skip(rel)) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      for (const _ of line.matchAll(call)) out.set(rel, [...(out.get(rel) ?? []), `${rel}:${i + 1}`])
    })
  }
  return out
}

/** Per file, what was found against what the map records. Empty when they agree. */
function mismatches(found: Map<string, string[]>, recorded: Record<string, number>): string[] {
  const files = new Set([...found.keys(), ...Object.keys(recorded)])
  return [...files].sort().flatMap((file) => {
    const now = found.get(file)?.length ?? 0
    const was = recorded[file] ?? 0
    return now === was ? [] : [`${file}: ${now} found, ${was} recorded — ${(found.get(file) ?? []).join(', ') || 'none'}`]
  })
}

describe('the single ingest door', () => {
  it('ingest.ts calls insertEvent and publishes exactly once each — those are the door', () => {
    const inserts = callsByFile(INSERT_CALL, (rel) => rel === DEFINITION).get(DOOR) ?? []
    const publishes = callsByFile(PUBLISH_CALL, () => false).get(DOOR) ?? []
    expect(inserts, inserts.join('\n')).toHaveLength(1)
    expect(publishes, publishes.join('\n')).toHaveLength(1)
  })

  it('direct insertEvent calls outside ingest are exactly the recorded ones, file by file', () => {
    const found = callsByFile(INSERT_CALL, (rel) => rel === DEFINITION || rel === DOOR)
    expect(mismatches(found, DIRECT_INSERT), 'set the entry to the new count (0 after a migration; never delete the line)')
      .toEqual([])
  })

  it('hand-written eventBus.publish calls outside ingest are exactly the recorded ones, file by file', () => {
    const found = callsByFile(PUBLISH_CALL, (rel) => rel === DOOR)
    expect(mismatches(found, HAND_PUBLISH), 'set the entry to the new count (0 after a migration; never delete the line)')
      .toEqual([])
  })
})
