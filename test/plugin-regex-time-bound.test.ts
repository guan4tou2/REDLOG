import { describe, it, expect, afterAll, beforeEach } from 'vitest'

// #499: a plugin's command-tag and target-extractor rules run on the ingest
// path (every shell command, and every page URL the browser connector sees) in
// the main process. They get the same time bound loot rules have (Spec 033):
// a rule that overruns is stopped and the others carry on.
//
// A pattern with a nested quantifier, against a run of one character followed
// by a character that cannot match, backtracks exponentially. 27 characters
// is seconds in-process.
const EVIL = '(a+)+$'
const HOSTILE = 'a'.repeat(27) + '!'
const BOUND_MS = 1500

describe('plugin command tags and target extractors have a time bound', async () => {
  const tagger = await import('../src/core/command-tagger')
  const extractor = await import('../src/core/target-extractor')
  const { _shutdownBoundedRegex } = await import('../src/core/bounded-regex')

  beforeEach(() => {
    for (const t of tagger._listCommandTags()) tagger.unregisterCommandTags(t.pluginId)
    for (const e of extractor._listExternalTargetExtractors()) extractor.unregisterTargetExtractors(e.pluginId)
  })
  afterAll(async () => {
    for (const t of tagger._listCommandTags()) tagger.unregisterCommandTags(t.pluginId)
    for (const e of extractor._listExternalTargetExtractors()) extractor.unregisterTargetExtractors(e.pluginId)
    await _shutdownBoundedRegex()
  })

  describe('command tags', () => {
    it('stops the rule that overruns, still applies the others, and does not run it again', () => {
      tagger.registerCommandTags('evil-tags', [{ name: 'backtrack', match: EVIL, stamp: { evil: '1' } }])
      tagger.registerCommandTags('good-tags', [{ name: 'nmap', match: '^nmap\\b', stamp: { tool: 'nmap' } }])
      let started = Date.now()
      const stamp = tagger.tagCommand(`nmap ${HOSTILE}`)
      expect(Date.now() - started).toBeLessThan(BOUND_MS)
      expect(stamp).toEqual({ tool: 'nmap' })
      expect(tagger._listCommandTags().find((t) => t.pluginId === 'evil-tags')?.stopped).toBe('time_limit')

      started = Date.now()
      tagger.tagCommand(HOSTILE)
      expect(Date.now() - started).toBeLessThan(500)
    })

    it('a re-registered plugin starts again', () => {
      tagger.registerCommandTags('evil-tags', [{ name: 'backtrack', match: EVIL, stamp: { evil: '1' } }])
      tagger.tagCommand(HOSTILE)
      tagger.unregisterCommandTags('evil-tags')
      tagger.registerCommandTags('evil-tags', [{ name: 'fixed', match: '^fixed$', stamp: { evil: '0' } }])
      expect(tagger._listCommandTags().find((t) => t.pluginId === 'evil-tags')?.stopped).toBeUndefined()
      expect(tagger.tagCommand('fixed')).toEqual({ evil: '0' })
    })

    it('keeps what the unbounded matcher did: an empty match tags, and a g flag keeps no state between commands', () => {
      tagger.registerCommandTags('edge', [
        { name: 'any', match: '^', stamp: { seen: 'yes' } },
        { name: 'sticky', match: 'nmap', flags: 'g', stamp: { tool: 'nmap' } }
      ])
      expect(tagger.tagCommand('nmap a')).toEqual({ seen: 'yes', tool: 'nmap' })
      expect(tagger.tagCommand('nmap b')).toEqual({ seen: 'yes', tool: 'nmap' })
    })
  })

  describe('target extractors', () => {
    it('stops a cmd matcher that overruns, and a later rule still finds the host', () => {
      extractor.registerTargetExtractors('evil-cmd', [{ cmd: EVIL, extract: '(\\S+)' }])
      extractor.registerTargetExtractors('good-ext', [{ cmd: '^acme-scan\\s', extract: '--target\\s+(\\S+)' }])
      const started = Date.now()
      const hit = extractor.extractTargetWithProvenance(`acme-scan --target 10.1.1.1 ${HOSTILE}`)
      expect(Date.now() - started).toBeLessThan(BOUND_MS)
      expect(hit).toMatchObject({ host: '10.1.1.1', pluginId: 'good-ext' })
      expect(extractor._listExternalTargetExtractors().find((e) => e.pluginId === 'evil-cmd')?.stopped).toBe('time_limit')
    })

    it('stops an extract pattern that overruns (the page URL is the target site\'s to choose)', () => {
      extractor.registerTargetExtractors('evil-ext', [{ cmd: '^https?:', extract: EVIL }])
      extractor.registerTargetExtractors('good-ext', [{ cmd: '^https?:', strategy: 'urlHost' }])
      const started = Date.now()
      const hit = extractor.extractTargetWithProvenance(`https://x.test/${HOSTILE}`)
      expect(Date.now() - started).toBeLessThan(BOUND_MS)
      expect(hit.host).toBe('x.test')
      expect(extractor._listExternalTargetExtractors().find((e) => e.pluginId === 'evil-ext')?.stopped).toBe('time_limit')
    })

    it('keeps the order and the strategy and capture-group behaviour', () => {
      extractor.registerTargetExtractors('first', [{ cmd: '^tool\\b', extract: '--host\\s+(\\S+)', name: 'by-flag' }])
      extractor.registerTargetExtractors('second', [{ cmd: '^tool\\b', strategy: 'lastIpOrDomain' }])
      expect(extractor.extractTargetWithProvenance('tool --host 10.0.0.1 10.0.0.2'))
        .toEqual({ host: '10.0.0.1', pluginId: 'first', extractorName: 'by-flag' })
      // first row does not yield: the next one is tried
      expect(extractor.extractTargetWithProvenance('tool 10.0.0.2')).toMatchObject({ host: '10.0.0.2', pluginId: 'second' })
      // a g flag keeps no state between calls
      extractor.registerTargetExtractors('flagged', [{ cmd: '^g-tool', extract: '(\\d+\\.\\d+\\.\\d+\\.\\d+)', flags: 'g' }])
      expect(extractor.extractTargetWithProvenance('g-tool 10.0.0.3').host).toBe('10.0.0.3')
      expect(extractor.extractTargetWithProvenance('g-tool 10.0.0.4').host).toBe('10.0.0.4')
    })

    it('a flag name given as `param` is a flag name, not a pattern', () => {
      extractor.registerTargetExtractors('param-ext', [{ cmd: '^tool\\b', strategy: 'flagValue', param: '-x[' }])
      let hit: ReturnType<typeof extractor.extractTargetWithProvenance> | undefined
      expect(() => { hit = extractor.extractTargetWithProvenance('tool -x[ 10.0.0.9') }).not.toThrow()
      expect(hit?.host).toBe('10.0.0.9')
    })
  })
})
