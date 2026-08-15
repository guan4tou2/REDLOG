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
import { loadConfig, saveConfig, loadScopeFile, burpHostToTarget, DEFAULT_VPN_ADAPTERS } from '../src/core/config'
import { classifyTarget } from '../src/core/scope-monitor'

let tmpDir: string

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

function write(yaml: string): void {
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml)
}

// dot-path → expected default. Keeping it as a table means adding a config
// field is a one-line change here, and forgetting to add one is visible —
// enforced by the guard test at the bottom of this file, not by memory.
const DEFAULTS: Array<[string, unknown]> = [
  ['engagement.id', 'default'],
  ['engagement.name', 'Default Engagement'],
  ['operator.id', 'operator-1'],
  ['operator.name', 'Operator'],

  ['network.whitelist', []],
  ['network.blacklist', []],
  ['network.lanProfile', []],
  ['network.checkInterval', 60],
  ['network.providers', []],
  ['network.confirmations', 3],
  ['network.ipMode', 'auto'],
  ['network.staleAfter', 2],
  ['network.showWifiName', false],

  ['scope.alertFloor', 'adjacent'],
  ['scope.targets', []],
  ['scope.excludeTargets', []],
  ['scope.proximityBits', 24],
  ['scope.publicSuffixes', []],
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
  ['deconfliction.authorityFloor', 'inferred'],

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

describe('shipped defaults — one assertion per option', () => {
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
    write('scope:\n  alertFloor: excluded_only\nagentTailer:\n  enabled: false\n')
    const c = loadConfig(tmpDir)
    expect(c.scope.alertFloor).toBe('excluded_only')
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

  // G-C3 turned this into a TWO-HOP chain: enforcement → warnOnViolation →
  // alertFloor. Both hops still run on load, so a config file written before
  // either rename lands on the right floor without the operator touching it.
  const floor = (): string => loadConfig(tmpDir).scope.alertFloor

  it('enforcement: warn → alerts on near-misses', () => {
    write('scope:\n  enforcement: warn\n')
    expect(floor()).toBe('adjacent')
  })

  it('enforcement: log → the quietest floor (the old mode did nothing)', () => {
    write('scope:\n  enforcement: log\n')
    expect(floor()).toBe('excluded_only')
  })

  // `excluded_only`, not a "none": `warnOnViolation: false` never silenced D1
  // either — excluded targets always raised regardless — so the two-value
  // control was always this floor under another name.
  it('the quietest floor still alerts on explicitly excluded targets', () => {
    write('scope:\n  enforcement: log\n')
    expect(floor()).not.toBe('none')
    expect(['excluded_only', 'adjacent', 'all']).toContain(floor())
  })

  it('enforcement: block (removed) → alerts ON — the strictest value cannot land on silence', () => {
    write('scope:\n  enforcement: block\n')
    expect(floor()).toBe('adjacent')
  })

  it('an unrecognised enforcement value migrates to alerts ON, not off', () => {
    write('scope:\n  enforcement: nonsense\n')
    expect(floor()).toBe('adjacent')
  })

  it('only the literal "log" — the one value that meant quiet — migrates to the quiet floor', () => {
    write('scope:\n  enforcement: LOG\n')
    expect(floor()).toBe('adjacent')
  })

  it('an explicit warnOnViolation is not overwritten by a stale enforcement key', () => {
    write('scope:\n  enforcement: log\n  warnOnViolation: true\n')
    expect(floor()).toBe('adjacent')
  })

  it('warnOnViolation: true → adjacent, false → excluded_only', () => {
    write('scope:\n  warnOnViolation: true\n')
    expect(floor()).toBe('adjacent')
    write('scope:\n  warnOnViolation: false\n')
    expect(floor()).toBe('excluded_only')
  })

  it('an explicit alertFloor wins over both legacy keys', () => {
    write('scope:\n  enforcement: log\n  warnOnViolation: false\n  alertFloor: all\n')
    expect(floor()).toBe('all')
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

  it('Burp/ZAP target-scope JSON: decodes each host shape and skips entries without one', () => {
    const p = scopeFile('burp.json', JSON.stringify({
      target: { scope: [{ host: '\\Qexample.com\\E' }, { host: '.*.example.com' }, {}] }
    }))
    expect(loadScopeFile(p)).toEqual(['example.com', '*.example.com'])
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

// G-CFG2: Burp holds a scope host as a REGEX. Only a `\Q` at position 0 used to
// be stripped, so Burp's own "and subdomains" export landed as `*\Qcorp.example.com`
// and matched nothing — the scope silently lost the hosts the engagement was about.
describe('burpHostToTarget — the shapes Burp and ZAP actually write', () => {
  const cases: Array<[string, string, string]> = [
    ['literal-quoted host', '\\Qexample.com\\E', 'example.com'],
    ['anchored, dot-escaped host', '^example\\.com$', 'example.com'],
    ['anchored + literal-quoted', '^\\Qexample.com\\E$', 'example.com'],
    ['and-subdomains, dot-escaped', '.*\\.example\\.com$', '*.example.com'],
    ['and-subdomains, literal-quoted', '.*\\Qcorp.example.com\\E', '*.corp.example.com'],
    ['and-subdomains, unescaped dot', '.*.example.com', '*.example.com'],
    ['and-subdomains with no joining dot', '.*example.com', '*.example.com'],
    ['deep host', '^\\Qapi.staging.example.com\\E$', 'api.staging.example.com'],
    ['bare hostname (already RedLog syntax)', 'example.com', 'example.com'],
    ['bare IP', '10.0.0.1', '10.0.0.1'],
    ['surrounding whitespace', '  \\Qexample.com\\E  ', 'example.com'],
    ['several quoted runs', '\\Qapi.\\E\\Qexample.com\\E', 'api.example.com'],
    ['unterminated \\Q run', '\\Qexample.com', 'example.com']
  ]

  for (const [name, host, expected] of cases) {
    it(`${name}: ${host} → ${expected}`, () => {
      expect(burpHostToTarget(host)).toBe(expected)
    })
  }

  // Hand-written patterns are handed back untouched: they match nothing, but a
  // scope target that VANISHES is the failure with no symptom — the operator
  // sees "scope loaded" and never learns what is missing from it.
  const passthrough = ['(dev|prod)\\.example\\.com', 'example\\.(com|net)', 'host[0-9]+\\.example\\.com', '.*']
  for (const host of passthrough) {
    it(`keeps an undecodable pattern visible rather than dropping it: ${host}`, () => {
      expect(burpHostToTarget(host)).toBe(host)
    })
  }

  it('a glob already in RedLog syntax survives unchanged', () => {
    expect(burpHostToTarget('*.example.com')).toBe('*.example.com')
  })

  it('the decoded target is what the scope classifier actually matches on', () => {
    // The point of the fix: the result has to work in classifyTarget, not just
    // look right. `*.corp.example.com` covers its anchor host and any child.
    const decoded = burpHostToTarget('.*\\Qcorp.example.com\\E')
    expect(classifyTarget('www.corp.example.com', { targets: [decoded], excludeTargets: [] })).toBe('in_scope')
    expect(classifyTarget('corp.example.com', { targets: [decoded], excludeTargets: [] })).toBe('in_scope')
    expect(classifyTarget('other.example.com', { targets: [decoded], excludeTargets: [] })).toBe('out_of_scope')
  })
})

// The maintenance contract, made executable.
//
// `docs/TESTING.md` ends with "adding a config option? add its default to the
// table in config-options". A sentence in a doc is not a gate: `proximityBits`,
// `authorityFloor`, `staleAfter`, `alertFloor` and `publicSuffixes` all landed
// during one week of work on this subsystem, and each was one forgotten line
// away from shipping a default that nothing asserts. This walks the real
// default config and fails on anything the table has not accounted for.
describe('the defaults table covers every shipped option', () => {
  /** Every leaf path of the default config, in dot form. Arrays count as leaves
   *  — a list default is a single value from the table's point of view. */
  function leafPaths(value: unknown, prefix = ''): string[] {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : []
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
  }

  // Asserted, but not as a literal: the adapter list has its own structural
  // tests, and the registry URL is matched by shape so a repo move is not a
  // failing test.
  const ASSERTED_ELSEWHERE = new Set(['network.vpnAdapters', 'marketplace.defaultRegistryUrl'])

  it('no option ships a default that the table does not name', () => {
    const covered = new Set(DEFAULTS.map(([path]) => path))
    const missing = leafPaths(loadConfig(tmpDir))
      .filter((p) => !covered.has(p) && !ASSERTED_ELSEWHERE.has(p))
    expect(missing, `add these to DEFAULTS (and to docs/TESTING.md Part 2): ${missing.join(', ')}`).toEqual([])
  })

  it('the table names no option that has been removed', () => {
    const live = new Set(leafPaths(loadConfig(tmpDir)))
    const stale = DEFAULTS.map(([path]) => path).filter((p) => !live.has(p))
    expect(stale, `these are in DEFAULTS but no longer in the config: ${stale.join(', ')}`).toEqual([])
  })

  it('every exemption still corresponds to a real option', () => {
    const live = new Set(leafPaths(loadConfig(tmpDir)))
    for (const path of ASSERTED_ELSEWHERE) expect(live.has(path)).toBe(true)
  })
})

