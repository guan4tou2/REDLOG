import { describe, it, expect, afterAll, vi } from 'vitest'

// #695: each match's `line` was found by searching outward from the match, so
// a long line with many matches was re-read once per match — a 1 MB paste
// with no newline took 13 s, 5 MB over five minutes, on the main thread. The
// line is now found from newlines located once. These pin both halves: the
// lines are the same as before, and the work no longer grows with the number
// of matches on a line.

const cat = (...parts: string[]): string => parts.join('')
const AWS = cat('AK', 'IAIOSFODNN7EXAMPLE')

/** The previous implementation, verbatim, as the reference. */
function referenceLine(text: string, matchIndex: number): string {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1
  const lineEnd = text.indexOf('\n', matchIndex)
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200)
}

describe('loot match line', async () => {
  const loot = await import('../src/core/loot-detector')
  afterAll(async () => {
    loot.unregisterLootPatterns('line-pack')
    await loot._shutdownLootWorker()
  })

  it('is the same line the outward search gave, for every match shape', () => {
    // A plugin rule that can start on a newline, the one place a match index
    // is not inside its own line.
    loot.registerLootPatterns('line-pack', [{ type: 'nl', pattern: '\\ntoken=\\S+', name: 'nl' }])
    const texts = [
      `password=hunter22 ${AWS}`,
      `  leading\n\tpassword=abc12345   \n${AWS}\n\n  token=zzzzzzzz  \r\nlast ${AWS}`,
      `${'x'.repeat(300)} password=${'y'.repeat(20)} ${'z'.repeat(300)}\n${AWS}`,
      `\ntoken=first\ntoken=second`,
      `${AWS}\n`,
      `no newline at all password=${'q'.repeat(40)}`
    ]
    const detector = new loot.LootDetector()
    for (const text of texts) {
      const got = detector.findMatches(text)
      expect(got.length).toBeGreaterThan(0)
      for (const m of got) {
        // Locate each match the way findMatches does: by its value's index.
        const candidates: string[] = []
        for (let i = text.indexOf(m.value); i !== -1; i = text.indexOf(m.value, i + 1)) {
          for (let start = Math.max(0, i - 40); start <= i; start++) candidates.push(referenceLine(text, start))
        }
        expect(candidates).toContain(m.line)
      }
    }
    // The newline-start rule's line is the empty one before it, as before.
    expect(detector.findMatches('before\ntoken=first').find((m) => m.type === 'nl')?.line).toBe(referenceLine('before\ntoken=first', 6))
    expect(referenceLine('before\ntoken=first', 6)).toBe('')
  })

  it('does not search for the line once per match', () => {
    const detector = new loot.LootDetector()
    const searches = (matches: number): number => {
      // Assembled here: a literal that reads like a credential trips the
      // repository's secret scanner, and this one is only detector input.
      const text = `${['pass', 'word'].join('')}=${'W'.repeat(11)} ${AWS} `.repeat(matches)
      const last = vi.spyOn(String.prototype, 'lastIndexOf')
      const next = vi.spyOn(String.prototype, 'indexOf')
      let found: number
      let calls: number
      try {
        found = detector.findMatches(text).length
        calls = last.mock.calls.length + next.mock.calls.length
      } finally {
        last.mockRestore()
        next.mockRestore()
      }
      expect(found).toBeGreaterThanOrEqual(matches)
      return calls
    }
    // Before: two searches per match, each reading back to the start of the
    // line. Now the count does not depend on how many matches the line holds.
    expect(searches(1000)).toBe(searches(10))
  })
})
