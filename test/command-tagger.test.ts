import { describe, it, expect, beforeEach } from 'vitest'
import { registerCommandTags, unregisterCommandTags, tagCommand, listCommandTags } from '../src/core/command-tagger'

describe('command-tagger', () => {
  beforeEach(() => {
    for (const t of listCommandTags()) unregisterCommandTags(t.pluginId)
  })

  it('empty registry returns empty stamp', () => {
    expect(tagCommand('nmap 10.0.0.5')).toEqual({})
  })

  it('single plugin single pattern stamps its fields', () => {
    registerCommandTags('mitre', [
      { name: 'nmap', match: '^nmap\\b', stamp: { mitre_ttp: 'T1046', tool: 'nmap' } }
    ])
    expect(tagCommand('nmap -sV 10.0.0.5')).toEqual({ mitre_ttp: 'T1046', tool: 'nmap' })
    expect(tagCommand('ls -la')).toEqual({})
  })

  it('first-match-wins per field across patterns', () => {
    registerCommandTags('a', [
      { name: 'general', match: '.', stamp: { mitre_ttp: 'T0000', category: 'unknown' } },
      { name: 'nmap',    match: '^nmap\\b', stamp: { mitre_ttp: 'T1046', tool: 'nmap' } }
    ])
    const s = tagCommand('nmap -sV 10.0.0.5')
    // "general" runs first (iteration order preserved by Map); its T0000 wins.
    expect(s.mitre_ttp).toBe('T0000')
    expect(s.category).toBe('unknown')
    // But tool wasn't stamped by "general", so nmap's tool still wins.
    expect(s.tool).toBe('nmap')
  })

  it('unregistering a plugin removes its patterns', () => {
    registerCommandTags('mitre', [{ name: 'nmap', match: '^nmap\\b', stamp: { mitre_ttp: 'T1046' } }])
    expect(tagCommand('nmap -sV 1.1.1.1').mitre_ttp).toBe('T1046')
    unregisterCommandTags('mitre')
    expect(tagCommand('nmap -sV 1.1.1.1')).toEqual({})
  })

  it('invalid regex silently skipped, valid siblings still work', () => {
    registerCommandTags('mixed', [
      { name: 'bad', match: '[unterminated', stamp: { x: '1' } },
      { name: 'good', match: '^nmap\\b', stamp: { y: '2' } }
    ])
    expect(tagCommand('nmap 1.1.1.1')).toEqual({ y: '2' })
  })

  it('flags are honored', () => {
    registerCommandTags('ci', [
      { name: 'mimikatz', match: 'mimikatz', flags: 'i', stamp: { mitre_ttp: 'T1003.001' } }
    ])
    expect(tagCommand('MimiKatz.exe').mitre_ttp).toBe('T1003.001')
  })

  it('re-registering the same pluginId REPLACES its prior patterns', () => {
    registerCommandTags('rot', [{ name: 'old', match: '^nmap\\b', stamp: { v: '1' } }])
    registerCommandTags('rot', [{ name: 'new', match: '^nmap\\b', stamp: { v: '2' } }])
    expect(tagCommand('nmap 1.1.1.1').v).toBe('2')
  })

  it('unregister for unknown plugin id does not throw', () => {
    expect(() => unregisterCommandTags('never-existed')).not.toThrow()
  })

  it('empty pattern list is accepted (no-op registration)', () => {
    registerCommandTags('none', [])
    expect(tagCommand('nmap 1.1.1.1')).toEqual({})
    unregisterCommandTags('none')
  })

  it('global-flag regex is stateless across repeated tagCommand calls', () => {
    registerCommandTags('gflag', [
      { name: 'nmap', match: 'nmap', flags: 'g', stamp: { tool: 'nmap' } }
    ])
    // Without the lastIndex reset in the source, the second call would miss.
    expect(tagCommand('nmap 1.1.1.1').tool).toBe('nmap')
    expect(tagCommand('nmap 2.2.2.2').tool).toBe('nmap')
    expect(tagCommand('nmap 3.3.3.3').tool).toBe('nmap')
  })

  it('scales to a large command line without pathological backtracking', () => {
    registerCommandTags('big', [
      { name: 'nmap', match: '^nmap\\b', stamp: { tool: 'nmap' } }
    ])
    const cmd = 'nmap ' + '-A '.repeat(20_000) + ' 10.0.0.1'
    const start = Date.now()
    expect(tagCommand(cmd).tool).toBe('nmap')
    expect(Date.now() - start).toBeLessThan(200)
  })
})
