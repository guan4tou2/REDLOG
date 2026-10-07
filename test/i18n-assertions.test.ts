import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM helper shared with scripts/verify-i18n-assertions.mjs
import { removedValues, isDistinctive, assertionsOnRemovedValues } from '../scripts/i18n-assertions.mjs'

// A deleted UI string is a deleted contract. Typecheck cannot see a string
// literal in a test, and the i18n key test checks the opposite direction, so
// the only thing that caught the last one was a full e2e round — six minutes
// in, and only because the gates before it happened to be green that time.
//
// The case that produced this gate: `capture.shellHookCapability` went with
// the onboarding checklist, and `e2e/first-run.spec.ts` kept asserting its
// sentence. Four more tests in that describe never ran as a result.

const file = (path: string, text: string): { path: string; text: string } => ({ path, text })

describe('i18n assertion gate', () => {
  it('reports a value that is gone, and ignores one that only changed key', () => {
    const before = { 'a.gone': 'this sentence was deleted', 'a.moved': 'this sentence stayed' }
    const after = { 'b.renamed': 'this sentence stayed' }
    const gone = removedValues(before, after)
    expect([...gone]).toEqual(['this sentence was deleted'])
  })

  it('ignores short values, because a gate that cries wolf gets deleted', () => {
    // "active", "idle", "off" each match hundreds of lines with nothing to do
    // with the UI.
    expect(isDistinctive('idle')).toBe(false)
    expect(isDistinctive('not installed')).toBe(false)
    expect(isDistinctive('commands only · redlog-run adds stdout/stderr')).toBe(true)
  })

  it('fails on a live assertion of a removed sentence, and names the file', () => {
    const removed = new Set(['commands only · redlog-run adds stdout/stderr'])
    const failures = assertionsOnRemovedValues(removed, [
      file('e2e/first-run.spec.ts', "await expect(page.getByText('commands only · redlog-run adds stdout/stderr')).toBeVisible()")
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('e2e/first-run.spec.ts')
  })

  it('does not fail on a comment that quotes the old wording', () => {
    // Explaining a change by quoting what it replaced is how these commits
    // read. The gate must not punish that.
    const removed = new Set(['commands only · redlog-run adds stdout/stderr'])
    const failures = assertionsOnRemovedValues(removed, [
      file('test/capture-http-row.test.tsx', "  // it used to read 'commands only · redlog-run adds stdout/stderr'"),
      file('test/other.test.ts', ' * commands only · redlog-run adds stdout/stderr, before the merge')
    ])
    expect(failures).toEqual([])
  })

  it('says nothing when the branch removed nothing', () => {
    expect(assertionsOnRemovedValues(new Set(), [file('test/x.test.ts', 'anything')])).toEqual([])
  })
})
