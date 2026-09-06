import { describe, it, expect, afterEach } from 'vitest'
import { loadPlugins } from '../src/core/plugins/loader'
import { applyContributions, removeContributions } from '../src/core/plugins/contributions'
import { extractTarget, extractTargetWithProvenance, listExternalTargetExtractors } from '../src/core/target-extractor'

// E1 Option B end-to-end: the built-in tool→target table is the bundled
// `builtin-tools` pack, discovered and applied through the real plugin loader —
// not hardcoded in core. This drives the actual loader + contributions path
// (the way initPlugins does at startup) to prove two properties the design
// promised: built-ins work once the pack is applied, and DISABLING the pack
// removes them (it is genuinely removable, not decoration).

describe('builtin-tools pack (E1 Option B)', () => {
  afterEach(() => { removeContributions('builtin-tools') })

  const pack = () => {
    const p = loadPlugins().find((x) => x.manifest.id === 'builtin-tools')
    if (!p) throw new Error('builtin-tools pack not found on disk')
    return p
  }

  it('is a valid, active, declarative bundled pack', () => {
    const p = pack()
    expect(p.status).toBe('active')
    expect(p.tier).toBe('declarative')
    expect(p.source).toBe('bundled')
    expect(p.manifest.contributes?.targetExtractors?.length).toBeGreaterThanOrEqual(30)
  })

  it('once applied, core extracts targets for the built-in tools', () => {
    applyContributions(pack())
    expect(extractTarget('nmap -sV 192.168.1.1')).toBe('192.168.1.1')
    expect(extractTarget('curl https://api.example.com/path')).toBe('api.example.com')
    expect(extractTarget('sqlmap -u "http://vuln.site/page?id=1"')).toBe('vuln.site')
    // Built-in matches carry no provenance — event shape stays byte-identical.
    expect(extractTargetWithProvenance('ssh user@10.0.0.1').pluginId).toBeUndefined()
  })

  it('is removable — disabling the pack drops the built-in extractors', () => {
    applyContributions(pack())
    expect(extractTarget('nmap -sV 192.168.1.1')).toBe('192.168.1.1')
    removeContributions('builtin-tools')
    // With the pack gone, core no longer recognises nmap (no URL to fall back
    // on) — the whole point of Option B: no tool knowledge left in core.
    expect(extractTarget('nmap -sV 192.168.1.1')).toBeNull()
    expect(listExternalTargetExtractors().filter((e) => e.pluginId === 'builtin-tools')).toHaveLength(0)
  })
})
