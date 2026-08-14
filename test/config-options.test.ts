// Every config block, field by field: the shipped default, what a partial file
// merges into, and what junk values do.
//
// `config.test.ts` covers the load/save/migrate narrative. This file is the
// exhaustive per-option table — a new field with a default that nobody wired up
// (or one whose default silently changes) shows up here rather than in a bug
// report from an engagement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig, saveConfig, loadScopeFile, DEFAULT_VPN_ADAPTERS } from '../src/core/config'

let tmpDir: string

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

function write(yaml: string): void {
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml)
}

describe('shipped defaults — one assertion per option', () => {
  // dot-path → expected default. Keeping it as a table means adding a config
  // field is a one-line change here, and forgetting to add one is visible.
  const DEFAULTS: Array<[string, unknown]> = [
    ['engagement.id', 'default'],
    ['engagement.name', 'Default Engagement'],
    ['operator.id', 'operator-1'],
    ['operator.name', 'Operator'],

    ['network.whitelist', []],
    ['network.blacklist', []],
    ['network.checkInterval', 60],
    ['network.providers', []],
    ['network.confirmations', 3],
    ['network.ipMode', 'auto'],
    ['network.showWifiName', false],

    ['scope.warnOnViolation', true],
    ['scope.targets', []],
    ['scope.excludeTargets', []],
    ['scope.proximityBits', 24],
    ['scope.scopeFile', null],

    ['screenshot.quality', 85],
    ['screenshot.intervalSec', 0],

    ['overlay.showMarkButton', true],
    ['overlay.showInDock', true],
    ['overlay.flashOnExposed', true],
    ['overlay.scale', 1.0],
    ['overlay.emphasizeExternalIp', false],
    ['overlay.passThrough', false],
    ['overlay.passThroughOpacity', 0.4],

    ['terminal.maxCastBytes', 52428800],   // 50 MB
    ['terminal.castKeepDays', 0],          // 0 = keep forever
    ['screenshots.keepDays', 0],
    ['io.keepDays', 0],
    ['io.warmDays', 0],
    ['io.maxBytes', 0],

    ['clipboard.enabled', false],          // opt-in: clipboards hold secrets
    ['clipboard.pollMs', 1500],
    ['clipboard.storePreview', false],

    ['browser.binary', ''],                // '' = auto-detect
    ['browser.proxy', 'http://127.0.0.1:8080'],
    ['browser.cdpPort', 9222],
    ['browser.isolateProfile', true],
    ['browser.ignoreCertErrors', true],
    ['browser.startUrl', ''],
    ['browser.extraArgs', []],

    ['redaction.allowlist', []],
    ['redaction.denylist', []],
    ['redaction.entropyThreshold', 4.5],
    ['redaction.minLength', 20],

    ['deconfliction.enabled', false],
    ['deconfliction.url', ''],
    ['deconfliction.secret', ''],
    ['deconfliction.events', ['marker', 'system', 'credential_use', 'c2_checkin']],
    ['deconfliction.subtypes', ['scope_violation']],
    ['deconfliction.includeData', false],

    ['cloudShare.endpoint', ''],
    ['cloudShare.authToken', ''],

    ['fileWatcher.enabled', false],
    ['fileWatcher.watchPaths', []],
    ['fileWatcher.ignorePatterns', []],

    ['processMonitor.enabled', false],
    ['processMonitor.pollMs', 500],
    ['processMonitor.ignoreCommands', []],

    ['agentTailer.enabled', true],         // on by default: AI audit coverage
    ['agentTailer.emitThinking', false]
  ]

  function at(obj: unknown, dotted: string): unknown {
    return dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj)
  }

  for (const [dotted, expected] of DEFAULTS) {
    it(`${dotted} = ${JSON.stringify(expected)}`, () => {
      expect(at(loadConfig(tmpDir), dotted)).toEqual(expected)
    })
  }

  it('marketplace.defaultRegistryUrl points at the bundled example registry', () => {
    expect(loadConfig(tmpDir).marketplace.defaultRegistryUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+index\.json$/)
  })

  it('ships the full VPN adapter list, all enabled', () => {
    const adapters = loadConfig(tmpDir).network.vpnAdapters
    expect(adapters).toEqual(DEFAULT_VPN_ADAPTERS)
    expect(adapters.every((a) => a.enabled)).toBe(true)
    expect(adapters.map((a) => a.name)).toContain('WireGuard')
  })

  it('every shipped VPN adapter pattern is a valid regex', () => {
    for (const a of DEFAULT_VPN_ADAPTERS) {
      expect(() => new RegExp(a.pattern, 'i')).not.toThrow()
    }
  })

  it('a corrupt config.yaml falls back to defaults rather than crashing the app', () => {
    write('network:\n  whitelist: [unclosed\n')
    expect(loadConfig(tmpDir).network.checkInterval).toBe(60)
  })

  it('an empty config.yaml falls back to defaults', () => {
    write('')
    expect(loadConfig(tmpDir).engagement.id).toBe('default')
  })
})

describe('merge semantics — what a partial file does to the rest', () => {
  it('a nested override leaves its siblings at the default', () => {
    write('network:\n  checkInterval: 5\n')
    const c = loadConfig(tmpDir)
    expect(c.network.checkInterval).toBe(5)
    expect(c.network.confirmations).toBe(3)
    expect(c.network.ipMode).toBe('auto')
  })

  it('arrays REPLACE, they do not concatenate', () => {
    write('deconfliction:\n  events:\n    - marker\n')
    expect(loadConfig(tmpDir).deconfliction.events).toEqual(['marker'])
  })

  it('an explicitly empty array wins over the default list', () => {
    write('deconfliction:\n  subtypes: []\n')
    expect(loadConfig(tmpDir).deconfliction.subtypes).toEqual([])
  })

  it('an explicit false is kept — not treated as "unset, use the default"', () => {
    write('scope:\n  warnOnViolation: false\nagentTailer:\n  enabled: false\n')
    const c = loadConfig(tmpDir)
    expect(c.scope.warnOnViolation).toBe(false)
    expect(c.agentTailer?.enabled).toBe(false)
  })

  it('an explicit 0 is kept — 0 is meaningful for every *Days / *Bytes field', () => {
    write('io:\n  keepDays: 0\n  warmDays: 7\n')
    const c = loadConfig(tmpDir)
    expect(c.io?.keepDays).toBe(0)
    expect(c.io?.warmDays).toBe(7)
  })

  it('an unknown key is carried through rather than dropped', () => {
    write('network:\n  futureOption: 42\n')
    const net = loadConfig(tmpDir).network as unknown as Record<string, unknown>
    expect(net.futureOption).toBe(42)
  })

  it('round-trips every block through save → load unchanged', () => {
    const c = loadConfig(tmpDir)
    c.network.whitelist = ['10.8.0.0/24']
    c.network.blacklist = ['1.2.3.4']
    c.network.ipMode = 'dns'
    c.overlay.scale = 1.25
    c.io = { keepDays: 30, warmDays: 7, maxBytes: 1024 }
    saveConfig(tmpDir, c)
    const back = loadConfig(tmpDir)
    expect(back.network.whitelist).toEqual(['10.8.0.0/24'])
    expect(back.network.ipMode).toBe('dns')
    expect(back.overlay.scale).toBe(1.25)
    expect(back.io).toEqual({ keepDays: 30, warmDays: 7, maxBytes: 1024 })
  })

  it('saveConfig creates the project directory when it does not exist yet', () => {
    const nested = path.join(tmpDir, 'a', 'b')
    saveConfig(nested, loadConfig(tmpDir))
    expect(fs.existsSync(path.join(nested, 'config.yaml'))).toBe(true)
  })
})

describe('legacy field migration', () => {
  const cases: Array<[string, string, 'whitelist' | 'blacklist', string[]]> = [
    ['vpnIPs → whitelist', 'network:\n  vpnIPs: [10.8.0.0/24]\n', 'whitelist', ['10.8.0.0/24']],
    ['safeIPs → whitelist', 'network:\n  safeIPs: [10.8.0.0/24]\n', 'whitelist', ['10.8.0.0/24']],
    ['dailyIPs → blacklist', 'network:\n  dailyIPs: [1.2.3.4]\n', 'blacklist', ['1.2.3.4']],
    ['exposedIPs → blacklist', 'network:\n  exposedIPs: [1.2.3.4]\n', 'blacklist', ['1.2.3.4']]
  ]
  for (const [name, yaml, field, expected] of cases) {
    it(name, () => {
      write(yaml)
      expect(loadConfig(tmpDir).network[field]).toEqual(expected)
    })
  }

  it('the newest name wins when several generations are present', () => {
    write('network:\n  whitelist: [10.0.0.0/8]\n  safeIPs: [172.16.0.0/12]\n  vpnIPs: [192.168.0.0/16]\n')
    expect(loadConfig(tmpDir).network.whitelist).toEqual(['10.0.0.0/8'])
  })

  it('safeIPs beats vpnIPs when both legacy names are present', () => {
    write('network:\n  safeIPs: [172.16.0.0/12]\n  vpnIPs: [192.168.0.0/16]\n')
    expect(loadConfig(tmpDir).network.whitelist).toEqual(['172.16.0.0/12'])
  })

  it('drops the legacy key so it cannot re-migrate on the next save', () => {
    write('network:\n  vpnIPs: [10.8.0.0/24]\n')
    const net = loadConfig(tmpDir).network as unknown as Record<string, unknown>
    expect(net.vpnIPs).toBeUndefined()
  })

  it('enforcement: warn → warnings on', () => {
    write('scope:\n  enforcement: warn\n')
    expect(loadConfig(tmpDir).scope.warnOnViolation).toBe(true)
  })

  it('enforcement: log → warnings OFF (the old mode did nothing)', () => {
    write('scope:\n  enforcement: log\n')
    expect(loadConfig(tmpDir).scope.warnOnViolation).toBe(false)
  })

  it('enforcement: block (removed) → warnings OFF — documented downgrade risk', () => {
    // A config written before `block` was removed asked for the STRICTEST
    // handling and lands on the quietest one. Recorded here as current
    // behaviour, not as the desired one — see docs/TESTING.md, gap G-CFG1.
    write('scope:\n  enforcement: block\n')
    expect(loadConfig(tmpDir).scope.warnOnViolation).toBe(false)
  })

  it('an explicit warnOnViolation is not overwritten by a stale enforcement key', () => {
    write('scope:\n  enforcement: log\n  warnOnViolation: true\n')
    expect(loadConfig(tmpDir).scope.warnOnViolation).toBe(true)
  })
})

describe('scope.scopeFile — external scope documents', () => {
  function scopeFile(name: string, body: string): string {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, body)
    return p
  }

  it('plain text: one target per line, # comments and blanks dropped', () => {
    const p = scopeFile('scope.txt', '# engagement scope\n\n10.0.0.0/8\n  *.example.com  \n')
    expect(loadScopeFile(p)).toEqual(['10.0.0.0/8', '*.example.com'])
  })

  it('a file with no extension is read as plain text', () => {
    const p = scopeFile('scope', 'target.example.com\n')
    expect(loadScopeFile(p)).toEqual(['target.example.com'])
  })

  it('JSON array of strings', () => {
    const p = scopeFile('scope.json', JSON.stringify(['10.0.0.1', 'target.com', 42]))
    expect(loadScopeFile(p)).toEqual(['10.0.0.1', 'target.com'])
  })

  it('Burp/ZAP target-scope JSON: unwraps a fully \\Q…\\E-quoted host', () => {
    const p = scopeFile('burp.json', JSON.stringify({
      target: { scope: [{ host: '\\Qexample.com\\E' }, { host: '.*.example.com' }, {}] }
    }))
    // entries without a host are skipped; a leading `.*` becomes the `*` wildcard
    expect(loadScopeFile(p)).toEqual(['example.com', '*.example.com'])
  })

  it('leaves a \\Q escape that is not at the start of the host in place (gap G-CFG2)', () => {
    // Burp writes `.*\Qcorp.example.com\E` for "and subdomains". The unwrap only
    // strips \Q at position 0, so this lands in the scope list with the escape
    // still attached and matches nothing. Recorded as current behaviour.
    const p = scopeFile('burp2.json', JSON.stringify({ target: { scope: [{ host: '.*\\Qcorp.example.com\\E' }] } }))
    expect(loadScopeFile(p)).toEqual(['*\\Qcorp.example.com'])
  })

  it('JSON that is neither shape yields an empty list, not a crash', () => {
    const p = scopeFile('other.json', JSON.stringify({ unrelated: true }))
    expect(loadScopeFile(p)).toEqual([])
  })

  it('malformed JSON yields an empty list', () => {
    const p = scopeFile('bad.json', '{ not json')
    expect(loadScopeFile(p)).toEqual([])
  })

  it('a missing file yields an empty list — an unreadable scope must not throw', () => {
    expect(loadScopeFile(path.join(tmpDir, 'nope.txt'))).toEqual([])
  })
})
