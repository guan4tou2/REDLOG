// Spec 074 T017 — which tests say something about the shared filter today.
//
// 074 replaces Spec 038's shared filter with filters each page owns (FR-085
// to FR-089; spec.md 「與既有文件…的衝突」). Every test below asserts, or
// is written against, the contract that goes away. They are listed so that
// the change cannot be made by editing tests until they pass: T071 and T072
// rewrite them one group at a time and take each file off this list in the
// same change, and Phase 8 asserts the list is empty.
//
// This is a ratchet in the shape of test/single-ingest-door.test.ts: a file
// that starts talking about the shared filter fails (the new test is written
// against a contract that is being retired; write it against the page's own
// filter), and so does a file that stopped (delete it from the list). The
// list is what verification.md records for T017, with each file's role.
//
// Detection is text, deliberately broad: `useSharedFilter(`, the words
// "shared filter" / "shared tier|source|target filter|chip", the "FilterBar
// chip", the FilterBar panel's id and the "Chained only" chip. A file that
// merely wraps its render in `FilterProvider` is not listed: it gives the
// panel its context and asserts nothing about it. SPEC_TABLE adds the files
// spec.md names that the words do not find.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

const TALKS_ABOUT_SHARED_FILTER = /useSharedFilter\s*\(|shared[- ]filter|shared (?:tier|source|target) (?:filter|chip)|FilterBar chip|filter-bar-panel|Chained only/i

/** Files spec.md's conflict table names (and revision E2's two) whatever the words say. */
const SPEC_TABLE: readonly string[] = [
  'test/timeline-search-live-burst.test.tsx',
  'test/timeline-stored-query-arrival.test.tsx'
]

/** Counted 2026-11-13 on origin/main faf3d376, including test/timeline-bands-filter.test.tsx from T016. */
const LISTED: readonly string[] = [
  'e2e/app-shell.spec.ts',
  'e2e/http-body-search.spec.ts',
  'e2e/layout-read-states.spec.ts',
  'e2e/layout-reliability.spec.ts',
  'e2e/timeline-evidence.spec.ts',
  'e2e/timeline-track.spec.ts',
  'test/display-zone-surfaces.test.tsx',
  'test/filter-bar-a11y.test.tsx',
  'test/filter-bar-tier.test.tsx',
  'test/filter-list-load-errors.test.tsx',
  'test/filter-time-range.test.tsx',
  'test/loot-completeness-ui.test.tsx',
  'test/search-query-corpus.harness.ts',
  'test/shared-filter-live-lists.test.tsx',
  'test/shared-filter-tier.test.ts',
  'test/shared-filter-views.test.tsx',
  'test/targets-open-in-timeline.test.tsx',
  'test/timeline-bands-filter.test.tsx',
  'test/timeline-filter-completeness.test.ts',
  'test/timeline-query-perf.test.ts',
  'test/timeline-search-live-burst.test.tsx',
  'test/timeline-shared-filter.test.tsx',
  'test/timeline-stored-query-arrival.test.tsx',
  'test/timeline-toolbar.test.tsx',
  'test/unapplied-filter-notice.test.tsx'
]

function found(): string[] {
  const self = repoRelative(ROOT, __filename)
  const out = new Set<string>(SPEC_TABLE)
  for (const f of glob.sync(['test/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}'], { cwd: ROOT })) {
    const rel = repoRelative(ROOT, path.join(ROOT, f))
    if (rel === self) continue
    if (TALKS_ABOUT_SHARED_FILTER.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) out.add(rel)
  }
  return [...out].sort()
}

describe('tests written against the shared filter (retired by Spec 074)', () => {
  it('the spec table\'s files exist', () => {
    for (const f of SPEC_TABLE) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('is no longer than the list, and has no stale entry (ratchet: only shrinks)', () => {
    const now = found()
    const added = now.filter((f) => !LISTED.includes(f))
    const stale = LISTED.filter((f) => !now.includes(f))
    expect(added, `new tests about the shared filter — write them against the page's own filter:\n${added.join('\n')}`).toEqual([])
    expect(stale, `no longer about the shared filter — delete from LISTED:\n${stale.join('\n')}`).toEqual([])
  })
})
