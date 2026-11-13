// Spec 073 T006. Ten project config.yaml files in the shapes projects have
// today, and what `loadConfig` returns for each, pinned as a golden; plus a
// frozen copy of today's DEFAULT_CONFIG.
//
// Why: Spec 073 moves machine-wide settings out of config.yaml and decides, per
// key, whether a project's value is its own or merely the old default. Both
// halves need to know what a given file means today. The golden is that
// meaning, written down before anything changes it; the frozen defaults are
// what the plan calls LEGACY_V1_DEFAULTS.
//
// The fixture files in test/fixtures/config-legacy/:
//   written-*  were written by today's `saveConfig` from DEFAULT_CONFIG plus a
//              patch (the test regenerates them and compares text, line
//              endings aside, so they stay "what main writes").
//   hand-*     are shapes `saveConfig` no longer produces (an old `overlay:`
//              block, sections left out); they are committed as they are.
//
// To rewrite after an intended change:
//   REDLOG_WRITE_CONFIG_LEGACY=1 npx vitest run test/config-legacy-golden.test.ts
//
// Note for readers of the Spec 073 plan: the owner's no-compatibility ruling
// (Spec 077 R8) may remove the need for LEGACY_V1_DEFAULTS and for reading old
// shapes at all. This file pins what exists; it does not argue it must stay.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, loadConfig, saveConfig, type RedLogConfig } from '../src/core/config'

const DIR = path.join(__dirname, 'fixtures', 'config-legacy')
const GOLDEN = path.join(DIR, 'loaded.golden.json')
const FROZEN = path.join(DIR, 'legacy-v1-defaults.json')
const WRITE = process.env.REDLOG_WRITE_CONFIG_LEGACY === '1'

type Patch = (c: RedLogConfig) => void

/** Written by saveConfig: DEFAULT_CONFIG with one change. */
const WRITTEN: Record<string, Patch> = {
  'written-default': () => {},
  'written-operator-changed': (c) => { c.operator = { id: 'alice-9', name: 'Alice Nguyen' } },
  'written-port-changed': (c) => { c.httpCapture = { ...c.httpCapture, port: 7788, listenHost: '0.0.0.0', routeTerminals: true } },
  'written-personal-domains-changed': (c) => { c.scope.personalDomains = ['127.0.0.0/8', '::1', 'localhost', '10.8.0.5', 'jump.example.test'] },
  'written-offline-and-whitelist': (c) => { c.network = { ...c.network, offline: true, whitelist: ['203.0.113.7'], ipMode: 'dns' } },
  'written-scope-and-loot': (c) => {
    c.scope = { ...c.scope, targets: ['app.example.test', '198.51.100.0/24'], excludeTargets: ['mail.example.test'], warnOnViolation: false }
    c.loot = { disabledRules: [] }
    c.redaction = { ...c.redaction, denylist: ['internal-token'] }
  },
  'written-packs-with-members': (c) => {
    c.packs = { hostMonitors: true, windowsOutput: false }
    c.packMembers = { processMonitor: false, fileWatcher: true }
  }
}

/** Shapes no current save produces. */
const HAND: Record<string, string> = {
  'hand-old-overlay-block': `engagement:
  id: old-project
  activeTarget: null
operator:
  id: operator-1
  name: Operator
overlay:
  autoShow: true
  opacity: 0.6
  clickThrough: false
  position: { x: 40, y: 60 }
network:
  whitelist: []
  checkInterval: 60
`,
  'hand-pack-members-absent': `engagement:
  id: no-members
operator:
  id: operator-1
  name: Operator
packs:
  hostMonitors: true
  windowsOutput: true
`,
  'hand-minimal': `engagement:
  id: minimal
`
}

const NAMES = [...Object.keys(WRITTEN), ...Object.keys(HAND)]

function writtenText(patch: Patch): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-legacy-'))
  try {
    const c = structuredClone(DEFAULT_CONFIG)
    patch(c)
    saveConfig(dir, c)
    return fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function load(name: string): RedLogConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-legacy-'))
  try {
    fs.copyFileSync(path.join(DIR, `${name}.yaml`), path.join(dir, 'config.yaml'))
    return JSON.parse(JSON.stringify(loadConfig(dir))) as RedLogConfig
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

const lf = (s: string): string => s.replace(/\r\n/g, '\n')

describe('config.yaml shapes in the field, as loadConfig reads them today (Spec 073 T006)', () => {
  it('writes the fixtures and the golden when asked', () => {
    if (!WRITE) return
    fs.mkdirSync(DIR, { recursive: true })
    for (const [name, patch] of Object.entries(WRITTEN)) fs.writeFileSync(path.join(DIR, `${name}.yaml`), writtenText(patch))
    for (const [name, text] of Object.entries(HAND)) fs.writeFileSync(path.join(DIR, `${name}.yaml`), text)
    fs.writeFileSync(FROZEN, JSON.stringify(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), null, 2) + '\n')
    const golden: Record<string, RedLogConfig> = {}
    for (const name of NAMES) golden[name] = load(name)
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n')
  })

  it('there are exactly ten fixtures and each is on disk', () => {
    expect(NAMES).toHaveLength(10)
    for (const name of NAMES) expect(fs.existsSync(path.join(DIR, `${name}.yaml`)), name).toBe(true)
  })

  it('the written-* fixtures are what saveConfig writes today', () => {
    for (const [name, patch] of Object.entries(WRITTEN)) {
      expect(lf(fs.readFileSync(path.join(DIR, `${name}.yaml`), 'utf8')), name).toBe(lf(writtenText(patch)))
    }
  })

  it('loadConfig returns the recorded value for every fixture', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, RedLogConfig>
    expect(Object.keys(golden).sort()).toEqual([...NAMES].sort())
    for (const name of NAMES) expect(load(name), name).toEqual(golden[name])
  })

  it('what the golden shows about the old shapes', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, RedLogConfig & { overlay?: unknown }>
    // The legacy overlay block is carried through the load untouched (main reads it once to seed the HUD).
    expect(golden['hand-old-overlay-block'].overlay).toMatchObject({ autoShow: true, opacity: 0.6 })
    // A key a file leaves out reads as the default; packMembers has none, so it stays absent.
    expect(golden['hand-minimal'].operator).toEqual({ id: 'operator-1', name: 'Operator' })
    expect(golden['hand-minimal'].httpCapture).toMatchObject({ port: 6661, listenHost: '127.0.0.1' })
    expect(golden['hand-pack-members-absent'].packMembers).toBeUndefined()
    expect(golden['written-packs-with-members'].packMembers).toEqual({ processMonitor: false, fileWatcher: true })
    // Today the operator is whatever the project file says.
    expect(golden['written-operator-changed'].operator).toEqual({ id: 'alice-9', name: 'Alice Nguyen' })
  })

  it('legacy-v1-defaults.json is today\'s DEFAULT_CONFIG; change DEFAULT_CONFIG and this fails, which is the cue to keep the old copy alive in code', () => {
    const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8'))
    expect(JSON.parse(JSON.stringify(DEFAULT_CONFIG))).toEqual(frozen)
  })
})
