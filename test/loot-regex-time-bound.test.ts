import { describe, it, expect, afterAll } from 'vitest'

// Spec 033 — a plugin loot rule cannot hold the main process. Before this spec
// every rule ran in-process, so one catastrophically backtracking pattern froze
// ingest (and with it the whole app) for as long as the regex ran.
//
// `(a+)+$` against a long run of `a` followed by `!` backtracks exponentially.
// At 32 characters it runs for minutes in-process.
const EVIL = '(a+)+$'
const HOSTILE = 'a'.repeat(32) + '!'
const cat = (...parts: string[]): string => parts.join('')
const AWS = cat('AK', 'IAIOSFODNN7EXAMPLE')

describe('loot rule time bound', async () => {
  const loot = await import('../src/core/loot-detector')
  afterAll(async () => {
    loot.unregisterLootPatterns('evil-pack')
    loot.unregisterLootPatterns('good-pack')
    await loot._shutdownLootWorker()
  })

  it('stops a plugin rule that exceeds the time bound, and still runs every other rule', () => {
    loot.registerLootPatterns('good-pack', [{ type: 'ticket', pattern: 'TKT-[0-9]{6}', name: 'ticket' }])
    loot.registerLootPatterns('evil-pack', [{ type: 'evil', pattern: EVIL, name: 'backtrack' }])
    const started = Date.now()
    const got = new loot.LootDetector().findMatches(`${HOSTILE} TKT-123456 ${AWS}`).map((m) => m.type)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(got).toEqual(expect.arrayContaining(['aws_key', 'ticket']))
    expect(got).not.toContain('evil')
  })

  it('reports the stopped rule, and does not run it again', () => {
    const rules = loot.listLootRules()
    expect(rules.find((r) => r.id === 'evil-pack:backtrack')?.stopped).toBe('time_limit')
    expect(rules.find((r) => r.id === 'good-pack:ticket')?.stopped).toBeUndefined()
    const started = Date.now()
    new loot.LootDetector().findMatches(HOSTILE)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('gives a reloaded plugin a fresh start', () => {
    loot.unregisterLootPatterns('evil-pack')
    loot.registerLootPatterns('evil-pack', [{ type: 'evil', pattern: 'EVIL-[0-9]+', name: 'backtrack' }])
    expect(loot.listLootRules().find((r) => r.id === 'evil-pack:backtrack')?.stopped).toBeUndefined()
    expect(new loot.LootDetector().findMatches('x EVIL-42').map((m) => m.value)).toContain('EVIL-42')
  })
})
