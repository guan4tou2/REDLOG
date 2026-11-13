import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_CONFIG, type RedLogConfig } from '../src/core/config'
import {
  APPLY_ORDER, CONFIG_DEPENDENCIES, OPEN_SEQUENCE, changedConfigPaths, planConfigApply,
  type ConfigApplyInput, type ConfigApplyStep
} from '../src/core/config-apply-plan'
import { createConfigApplier, type ConfigApplyDeps, type ConfigApplier } from '../src/main/config-apply'
import type { ProjectContext } from '../src/core/project-runtime'
import type { LoadedPlugin } from '../src/core/plugins/types'

// ─── Golden order ────────────────────────────────────────────────────────────
//
// Recorded from src/main/index.ts at a087c16c, BEFORE the apply path existed:
// the config-applying calls of `startProjectResources` (up to configureApi)
// and of `saveProjectConfig`, in source order, applyCapturePacks expanded in
// place. `hook:*` marks where the open did its own work in between
// (invalidateObservationCount…, setTailerContributionSink + initPlugins,
// configureTerminalProxy + setCastProbe, sweepRetention … startOpsecMonitor).
// The save list began with applyOperatorChange and saveConfig, which stay in
// the save itself, before the apply.
const GOLDEN_OPEN = [
  'showWifiName', 'screenshotAgent.configure', 'hook:resetProjectCaches', 'alertRuntime.resetOnProjectSwitch',
  'alertRuntime.configure', 'lootDetector.configure', 'configureCaptureHealth', 'configureRedaction', 'hook:loadPlugins',
  'setVpnAdapters', 'configureTerminal', 'hook:wireTerminalIngest', 'configureIngest', 'hook:startProjectServices',
  'configureFileWatcher', 'configureConnectionMonitor',
  'configurePowershellTranscript', 'configureProcessMonitor', 'configureAgentTailer',
  'configureFileWatcher', 'configureConnectionMonitor', 'configureProcessMonitor', 'configurePowershellTranscript',
  'configureAgentTailer'
]
const GOLDEN_SAVE = [
  'configureIngest', 'logConfigDiff', 'showWifiName', 'publishLink', 'broadcastIPStatus', 'alertRuntime.configure',
  'screenshotAgent.configure', 'configureCaptureHealth', 'stopManagedHttpCapture', 'startManagedHttpCapture',
  'scheduleScopeRecompute', 'configureTerminal', 'lootDetector.configure',
  'configureFileWatcher', 'configureConnectionMonitor', 'configureProcessMonitor',
  'configureFileWatcher', 'configureConnectionMonitor', 'configureProcessMonitor', 'configurePowershellTranscript',
  'configureAgentTailer', 'configureRedaction', 'setVpnAdapters'
]

/** Calls that start, stop or restart a capture source (or re-arm the IP
 *  lookup timer / the screenshot interval). */
const CAPTURE_CALLS = new Set([
  'configureFileWatcher', 'configureConnectionMonitor',
  'configureProcessMonitor', 'configurePowershellTranscript', 'configureAgentTailer',
  'stopManagedHttpCapture', 'startManagedHttpCapture', 'screenshotAgent.configure', 'alertRuntime.configure'
])

const cfg = (mut?: (c: RedLogConfig) => void): RedLogConfig => {
  const c = structuredClone(DEFAULT_CONFIG)
  c.engagement.id = 'eng-a'
  mut?.(c)
  return c
}
const input = (config: RedLogConfig, scopeInForce: string[] = config.scope.targets): ConfigApplyInput => ({ config, scopeInForce })
const steps = (plan: ReturnType<typeof planConfigApply>): string[] => plan.entries.map((e) => ('step' in e ? e.step : `hook:${e.hook}`))

const ACTIVE_PACK_PLUGINS = [
  { manifest: { id: 'pack-host-monitors' }, source: 'bundled', status: 'active' },
  { manifest: { id: 'pack-windows-output' }, source: 'bundled', status: 'active' }
] as unknown as LoadedPlugin[]

function harness(): { deps: ConfigApplyDeps; log: string[]; args: Array<[string, unknown]>; current: Set<number>; ctx: (generation: number) => ProjectContext } {
  const log: string[] = []
  const args: Array<[string, unknown]> = []
  const current = new Set<number>()
  let wifi = false
  let proxyPort = 6661
  const rec = (name: string) => (a?: unknown): void => { log.push(name); args.push([name, a]) }
  const deps: ConfigApplyDeps = {
    isCurrent: (identity) => current.has(identity.generation),
    getShowWifiName: () => wifi,
    setShowWifiName: (on) => { wifi = on; log.push('showWifiName') },
    publishLink: rec('publishLink'),
    broadcastIPStatus: rec('broadcastIPStatus'),
    screenshotConfigure: rec('screenshotAgent.configure'),
    alertResetOnProjectSwitch: rec('alertRuntime.resetOnProjectSwitch'),
    alertConfigure: (c, _i, t) => { log.push('alertRuntime.configure'); args.push(['alertRuntime.configure', t]) },
    lootConfigure: rec('lootDetector.configure'),
    configureCaptureHealth: rec('configureCaptureHealth'),
    configureRedaction: rec('configureRedaction'),
    setVpnAdapters: rec('setVpnAdapters'),
    configureTerminal: rec('configureTerminal'),
    ingestCollaborators: () => ({ collaborators: true }),
    configureIngest: rec('configureIngest'),
    configureFileWatcher: rec('configureFileWatcher'),
    configureConnectionMonitor: rec('configureConnectionMonitor'),
    configurePowershellTranscript: rec('configurePowershellTranscript'),
    configureProcessMonitor: rec('configureProcessMonitor'),
    configureAgentTailer: rec('configureAgentTailer'),
    logConfigDiff: () => { log.push('logConfigDiff'); return 'audit-row' },
    proxyEndpoint: (c) => ({ host: c.httpCapture.listenHost, port: c.httpCapture.port }),
    proxyRunning: () => true,
    stopManagedHttpCapture: rec('stopManagedHttpCapture'),
    startManagedHttpCapture: () => { log.push('startManagedHttpCapture'); proxyPort++ },
    scheduleScopeRecompute: (before, id) => { log.push('scheduleScopeRecompute'); args.push(['scheduleScopeRecompute', { before, id }]) },
    apiPort: () => 6660,
    lootDetector: {},
    scopeDispatch: () => {},
    hookExcludedPaths: () => [],
    listPlugins: () => ACTIVE_PACK_PLUGINS,
    agentCatalog: () => ({ catalog: [], modulePath: () => undefined }),
    homedir: () => '/home/op'
  }
  void proxyPort
  const ctx = (generation: number): ProjectContext => ({ projectId: `p${generation}`, engagementId: 'eng-a', operatorId: 'op', generation, signal: new AbortController().signal })
  return { deps, log, args, current, ctx }
}

const HOOKS = (log: string[]): Record<string, () => void> => Object.fromEntries(
  ['resetProjectCaches', 'loadPlugins', 'wireTerminalIngest', 'startProjectServices'].map((h) => [h, () => { log.push(`hook:${h}`) }])
)

describe('config apply plan: the dependency map', () => {
  // Field → exactly the steps it plans on a save. `audit` and `captureHealth`
  // follow every change (an audit row when a security field moved; a cache
  // refresh) and start or stop nothing.
  const ALWAYS = ['audit', 'captureHealth']
  const cases: Array<[string, (c: RedLogConfig) => void, ConfigApplyStep[]]> = [
    ['a loot rule', (c) => { c.loot = { disabledRules: [] } }, ['lootDetector']],
    ['retention keep-days', (c) => { c.retention!.casts = { keepDays: 7, maxBytes: 0 } }, []],
    ['the capture browser start URL', (c) => { c.browser.startUrl = 'https://x.test' }, []],
    ['personal domains', (c) => { c.scope.personalDomains = ['me.test'] }, []],
    ['route terminals through the proxy', (c) => { c.httpCapture.routeTerminals = true }, []],
    ['the legacy HUD block', (c) => { (c as unknown as { overlay: unknown }).overlay = { autoShow: false } }, []],
    ['connection monitor poll', (c) => { c.connectionMonitor = { pollMs: 5000 } }, ['connectionMonitorOptions']],
    ['process monitor ignore list', (c) => { c.processMonitor = { pollMs: 500, ignoreCommands: ['ls'] } }, ['processMonitorOptions']],
    ['file watcher paths', (c) => { c.fileWatcher = { watchPaths: ['/w'], ignorePatterns: [] } }, ['fileWatcherOptions']],
    ['the host monitors pack', (c) => { c.packs!.hostMonitors = true }, ['packFileWatcher', 'packConnectionMonitor', 'packProcessMonitor']],
    ['one pack member', (c) => { c.packMembers = { processMonitor: false } }, ['packProcessMonitor']],
    ['the Windows output pack', (c) => { c.packs!.windowsOutput = true }, ['packPowershellTranscript']],
    ['an AI source', (c) => { c.agentTailer = { sources: { 'claude-code': { enabled: true } } } }, ['agentTailer']],
    ['agent thinking blocks', (c) => { c.agentTailer = { emitThinking: true } }, ['agentTailer']],
    ['the proxy port', (c) => { c.httpCapture.port = 7000 }, ['managedProxy']],
    ['the proxy listen address', (c) => { c.httpCapture.listenHost = '0.0.0.0' }, ['managedProxy']],
    ['screenshot interval', (c) => { c.screenshot.intervalSec = 30 }, ['screenshot']],
    ['scope targets', (c) => { c.scope.targets = ['t.test'] }, ['alertRuntime', 'scopeRecompute']],
    ['scope file', (c) => { c.scope.scopeFile = '/nope.txt' }, ['alertRuntime', 'scopeRecompute']],
    ['warn on violation', (c) => { c.scope.warnOnViolation = false }, ['alertRuntime', 'scopeRecompute']],
    ['the IP blacklist', (c) => { c.network.blacklist = ['1.2.3.4'] }, ['alertRuntime']],
    ['air-gap', (c) => { c.network.offline = true }, ['alertRuntime']],
    ['the operator name', (c) => { c.operator.name = 'Bob' }, ['alertRuntime']],
    ['show Wi-Fi name', (c) => { c.network.showWifiName = true }, ['wifiName']],
    ['VPN adapters', (c) => { c.network.vpnAdapters = [] }, ['vpnAdapters']],
    ['redaction', (c) => { c.redaction.minLength = 8 }, ['redaction']],
    ['max cast bytes', (c) => { c.terminal.maxCastBytes = 1 }, ['terminal']],
    ['the current target', (c) => { c.engagement.activeTarget = 't.test' }, ['ingestActiveTarget']]
  ]
  for (const [name, mut, expected] of cases) {
    it(`changing ${name} plans exactly ${expected.join(', ') || 'no subsystem'}`, () => {
      const plan = planConfigApply(input(cfg()), input(cfg(mut)), 'save')
      expect(plan.unknownPaths).toEqual([])
      expect(steps(plan).sort()).toEqual([...expected, ...ALWAYS].sort())
    })
  }

  it('an identical save plans nothing', () => {
    expect(steps(planConfigApply(input(cfg()), input(cfg()), 'save'))).toEqual([])
  })

  it('a scope file edited on disk reconfigures the scope policy', () => {
    const c = cfg((x) => { x.scope.scopeFile = '/s.txt' })
    expect(steps(planConfigApply(input(c, ['a']), input(c, ['a', 'b']), 'save'))).toEqual(['audit', 'alertRuntime', 'captureHealth'])
  })

  it('the first application after open plans everything, in the open order', () => {
    expect(planConfigApply(null, input(cfg()), 'open').entries).toBe(OPEN_SEQUENCE)
    // Including a "previous" changes nothing: an open always starts over.
    expect(planConfigApply(input(cfg()), input(cfg()), 'open').entries).toBe(OPEN_SEQUENCE)
  })

  it('a save with nothing applied before it plans every save step', () => {
    expect(steps(planConfigApply(null, input(cfg()), 'save'))).toEqual([...APPLY_ORDER])
  })

  it('an unclassified field plans everything and names the field', () => {
    const plan = planConfigApply(input(cfg()), input(cfg((c) => { (c as unknown as Record<string, unknown>).brandNew = 1 })), 'save')
    expect(plan.unknownPaths).toEqual(['brandNew'])
    expect(steps(plan)).toEqual([...APPLY_ORDER])
  })

  it('classifies every field the default config has', () => {
    const leaves = changedConfigPaths(DEFAULT_CONFIG, {}).map((p) => p.join('.'))
    expect(leaves.length).toBeGreaterThan(30)
    for (const leaf of leaves) {
      const next = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>
      let cur = next
      const parts = leaf.split('.')
      for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>
      cur[parts[parts.length - 1]] = '__changed__'
      expect({ leaf, unknown: planConfigApply(input(DEFAULT_CONFIG), input(next as unknown as RedLogConfig), 'save').unknownPaths }).toEqual({ leaf, unknown: [] })
    }
  })

  it('plugins and hook exclusions plan what the diff cannot see, and only that', () => {
    expect(steps(planConfigApply(input(cfg()), input(cfg()), 'plugins-changed'))).toEqual(
      ['packFileWatcher', 'packConnectionMonitor', 'packProcessMonitor', 'packPowershellTranscript', 'agentTailer'])
    expect(steps(planConfigApply(input(cfg()), input(cfg()), 'hook-config'))).toEqual(['agentTailer'])
  })

  it('a new project seed plans nothing; the current target plans ingest only', () => {
    expect(steps(planConfigApply(input(cfg()), input(cfg((c) => { c.scope.targets = ['x'] })), 'create'))).toEqual([])
    expect(steps(planConfigApply(input(cfg()), input(cfg((c) => { c.engagement.activeTarget = 't' })), 'target-context')))
      .toEqual(['ingestActiveTarget', 'captureHealth'])
  })

  it('every step has a dependency entry', () => {
    for (const s of APPLY_ORDER) expect(CONFIG_DEPENDENCIES[s]).toBeDefined()
  })
})

describe('config apply: one path for every entry point', () => {
  let h: ReturnType<typeof harness>
  let applier: ConfigApplier
  let open: ProjectContext
  beforeEach(() => {
    h = harness()
    applier = createConfigApplier(h.deps)
    open = h.ctx(1)
    h.current.add(1)
  })
  const openWith = (c: RedLogConfig): void => { applier.apply({ reason: 'open', identity: open, next: c, hooks: HOOKS(h.log) }) }
  const save = (prev: RedLogConfig, next: RedLogConfig): void => { applier.apply({ reason: 'save', identity: open, next, diskPrev: prev }) }

  it('open runs the full sequence in the order it ran before this module', () => {
    openWith(cfg())
    expect(h.log).toEqual(GOLDEN_OPEN)
  })

  it('a save that touches every subsystem runs them in the order config:save did', () => {
    const before = cfg()
    openWith(before)
    h.log.length = 0
    // An unclassified field plans every step; the Wi-Fi switch and the proxy
    // endpoint make the conditional calls happen.
    const after = cfg((c) => { (c as unknown as Record<string, unknown>).brandNew = 1; c.network.showWifiName = true; c.httpCapture.port = 7001 })
    save(before, after)
    expect(h.log).toEqual(GOLDEN_SAVE)
  })

  const unrelated: Array<[string, (c: RedLogConfig) => void]> = [
    ['a loot rule', (c) => { c.loot = { disabledRules: ['jwt'] } }],
    ['retention', (c) => { c.retention!.loggedTier = { keepDays: 30, sweepIntervalHours: 24 } }],
    ['the legacy HUD block', (c) => { (c as unknown as { overlay: unknown }).overlay = { opacity: 0.5 } }],
    ['the capture browser (appearance of a later launch)', (c) => { c.browser.isolateProfile = false }],
    ['nothing at all (an autosave with no edit)', () => {}]
  ]
  for (const [name, mut] of unrelated) {
    it(`a save that changes ${name} stops and starts no capture source`, () => {
      const before = cfg()
      openWith(before)
      h.log.length = 0
      save(before, cfg(mut))
      expect(h.log.filter((c) => CAPTURE_CALLS.has(c))).toEqual([])
    })
  }

  it('a capture setting restarts only what depends on it', () => {
    const before = cfg()
    openWith(before)
    h.log.length = 0
    save(before, cfg((c) => { c.connectionMonitor = { pollMs: 4000 } }))
    expect(h.log.filter((c) => CAPTURE_CALLS.has(c))).toEqual(['configureConnectionMonitor'])

    h.log.length = 0
    const prev = cfg((c) => { c.connectionMonitor = { pollMs: 4000 } })
    save(prev, cfg((c) => { c.connectionMonitor = { pollMs: 4000 }; c.httpCapture.port = 7002 }))
    expect(h.log.filter((c) => CAPTURE_CALLS.has(c))).toEqual(['stopManagedHttpCapture', 'startManagedHttpCapture'])
  })

  it('turning the host monitors pack on reconfigures its three members and nothing else', () => {
    const before = cfg()
    openWith(before)
    h.log.length = 0
    h.args.length = 0
    save(before, cfg((c) => { c.packs!.hostMonitors = true }))
    expect(h.log.filter((c) => CAPTURE_CALLS.has(c)).sort()).toEqual(
      ['configureConnectionMonitor', 'configureFileWatcher', 'configureProcessMonitor'])
    expect(h.args.find(([n]) => n === 'configureProcessMonitor')?.[1]).toEqual({ enabled: true })
  })

  it('the scope recompute and audit describe the change from the file as it was', () => {
    const before = cfg((c) => { c.scope.targets = ['old.test'] })
    openWith(before)
    h.args.length = 0
    save(before, cfg((c) => { c.scope.targets = ['new.test'] }))
    expect(h.args.find(([n]) => n === 'scheduleScopeRecompute')?.[1]).toEqual({
      before: { targets: ['old.test'], excludeTargets: [], alertFloor: expect.anything() }, id: 'audit-row'
    })
    expect(h.args.find(([n]) => n === 'alertRuntime.configure')?.[1]).toEqual(['new.test'])
  })

  it('plans against what was last applied, not against the file', () => {
    const before = cfg()
    openWith(before)
    save(before, cfg((c) => { c.connectionMonitor = { pollMs: 700 } }))
    h.log.length = 0
    // The same edit arriving again (a re-sent autosave) changes nothing applied.
    save(cfg(), cfg((c) => { c.connectionMonitor = { pollMs: 700 } }))
    expect(h.log.filter((c) => CAPTURE_CALLS.has(c))).toEqual([])
  })

  it('create applies nothing, even to the project that is open', () => {
    openWith(cfg())
    h.log.length = 0
    expect(applier.apply({ reason: 'create', identity: open, next: cfg((c) => { c.packs!.hostMonitors = true }) })?.entries).toEqual([])
    expect(h.log).toEqual([])
  })

  describe('concurrency', () => {
    it('an apply requested from inside an apply waits, and the newest config wins', () => {
      const before = cfg()
      openWith(before)
      h.log.length = 0
      h.args.length = 0
      let reentered = false
      const inner = h.deps.lootConfigure
      h.deps.lootConfigure = (opts) => {
        inner(opts)
        if (reentered) return
        reentered = true
        // Two more saves land while the first is still applying.
        expect(applier.apply({ reason: 'save', identity: open, next: cfg((c) => { c.loot = { disabledRules: ['a'] } }), diskPrev: before })).toBeNull()
        expect(applier.apply({ reason: 'save', identity: open, next: cfg((c) => { c.loot = { disabledRules: ['b'] } }), diskPrev: before })).toBeNull()
        // Nothing of them ran yet: the outer apply is not finished.
        expect(h.log.filter((c) => c === 'lootDetector.configure')).toHaveLength(1)
      }
      save(before, cfg((c) => { c.loot = { disabledRules: [] } }))
      const loot = h.args.filter(([n]) => n === 'lootDetector.configure').map(([, a]) => a)
      // The first save, then ONE coalesced apply of the last one.
      expect(loot).toEqual([{ disabledRules: [] }, { disabledRules: ['b'] }])
      expect(applier.applied()?.input.config.loot?.disabledRules).toEqual(['b'])
    })

    it('coalesced requests keep every reason\'s steps', () => {
      const before = cfg()
      openWith(before)
      h.log.length = 0
      let once = false
      const inner = h.deps.lootConfigure
      h.deps.lootConfigure = (opts) => {
        inner(opts)
        if (once) return
        once = true
        applier.apply({ reason: 'hook-config', identity: open, next: cfg((c) => { c.loot = { disabledRules: [] } }) })
      }
      save(before, cfg((c) => { c.loot = { disabledRules: [] } }))
      expect(h.log.filter((c) => c === 'configureAgentTailer')).toHaveLength(1)
    })

    it('a project switch during an apply stops it, and its queued work never reaches the next project', () => {
      const before = cfg()
      openWith(before)
      h.log.length = 0
      const inner = h.deps.lootConfigure
      h.deps.lootConfigure = (opts) => {
        inner(opts)
        applier.apply({ reason: 'save', identity: open, next: cfg((c) => { c.connectionMonitor = { pollMs: 1 } }), diskPrev: before })
        // The operator switches project while this apply is running.
        h.current.delete(1)
        h.current.add(2)
      }
      save(before, cfg((c) => { c.loot = { disabledRules: [] }; c.network.vpnAdapters = [] }))
      // vpnAdapters comes after the loot detector: it must not have run.
      expect(h.log).not.toContain('setVpnAdapters')
      // The queued save belonged to the old project.
      expect(h.log).not.toContain('configureConnectionMonitor')
      // And what was "applied" is not recorded as this save.
      expect(applier.applied()?.input.config.loot?.disabledRules).toEqual(DEFAULT_CONFIG.loot!.disabledRules)
    })

    it('a request for a project that is no longer open is dropped', () => {
      openWith(cfg())
      h.current.delete(1)
      h.log.length = 0
      expect(applier.apply({ reason: 'save', identity: open, next: cfg((c) => { c.connectionMonitor = { pollMs: 2 } }), diskPrev: cfg() })).toBeNull()
      expect(h.log).toEqual([])
    })

    it('after a close the next project starts from nothing applied', () => {
      openWith(cfg((c) => { c.connectionMonitor = { pollMs: 3 } }))
      applier.reset()
      expect(applier.applied()).toBeNull()
      h.current.clear()
      const next = h.ctx(2)
      h.current.add(2)
      h.log.length = 0
      applier.apply({ reason: 'open', identity: next, next: cfg(), hooks: HOOKS(h.log) })
      expect(h.log).toEqual(GOLDEN_OPEN)
      expect(applier.applied()?.generation).toBe(2)
    })
  })
})
