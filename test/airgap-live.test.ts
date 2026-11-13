// Spec 073 T008 (US3, SC-005): switching `network.offline` on while a project is
// open stops everything RedLog sends of its own.
//
// What a "patch" is here: the same two things `config:save` does — write the
// new config.yaml, then hand the new config to the real `createConfigApplier`
// with reason `save`. The applier is wired as src/main/index.ts wires it for
// the one step an air-gap change plans (`alertRuntime`, which reconfigures the
// real AlertRuntime and its IP producer); everything else in its deps is inert.
//
// What is counted: outbound requests at the network doubles — UDP sends
// (`dgram`, the NTP query), DNS resolver calls (`dns/promises`, the IP lookup),
// `https.request` (the OpenTimestamps calendars) and `fetch` (the IP HTTP
// providers; the update check's release lookup). Timers are faked and advanced
// across the longest period any of those loops has, so a loop that was left
// running has its tick.
//
// Today only the IP lookup and the anchor stop: the IP producer is told
// `offline` by the alertRuntime step, and the anchor reads config.yaml on each
// call. The NTP loop is started at open if not air-gapped and nothing stops it;
// the updater's air-gap flag is set at open only. Those two are `it.fails`.
// The control case (air-gap never on) is what keeps the zero counts honest:
// each counter is shown able to move.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'

const net = vi.hoisted(() => ({ ntp: 0, dns: 0, calendars: 0, ipHttp: 0, update: 0, other: [] as string[] }))

vi.mock('dgram', () => {
  const createSocket = (): unknown => ({
    on: () => undefined,
    close: () => undefined,
    send: (_p: unknown, _port: unknown, _host: unknown, cb: (e: Error | null) => void) => { net.ntp++; cb(new Error('no network in tests')) }
  })
  return { default: { createSocket }, createSocket }
})
vi.mock('dns/promises', () => {
  class Resolver {
    setServers(): void { /* */ }
    async resolve4(): Promise<string[]> { net.dns++; throw new Error('no network in tests') }
    async resolveTxt(): Promise<string[][]> { net.dns++; throw new Error('no network in tests') }
  }
  return { Resolver, default: { Resolver } }
})
vi.mock('https', () => {
  const request = (): unknown => {
    net.calendars++
    const handlers: Record<string, (e?: Error) => void> = {}
    return {
      on: (ev: string, fn: (e?: Error) => void) => { handlers[ev] = fn },
      write: () => undefined,
      destroy: () => undefined,
      end: () => { queueMicrotask(() => handlers.error?.(new Error('no network in tests'))) }
    }
  }
  return { default: { request }, request }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const sqlite = requires('better-sqlite3')

type Mod<T> = T
let dbMod: Mod<typeof import('../src/core/db/index')>
let evMod: Mod<typeof import('../src/core/db/events')>
let cfgMod: Mod<typeof import('../src/core/config')>
let clock: Mod<typeof import('../src/core/clock')>
let anchor: Mod<typeof import('../src/core/chain-anchor')>
let updater: Mod<typeof import('../src/main/services/updater')>
let applyMod: Mod<typeof import('../src/main/config-apply')>
let alertMod: Mod<typeof import('../src/main/services/alert-runtime')>

if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  evMod = await import('../src/core/db/events')
  cfgMod = await import('../src/core/config')
  clock = await import('../src/core/clock')
  anchor = await import('../src/core/chain-anchor')
  updater = await import('../src/main/services/updater')
  applyMod = await import('../src/main/config-apply')
  alertMod = await import('../src/main/services/alert-runtime')
}

const HOUR = 3_600_000
/** Longer than every loop's period: IP 10 s, NTP 5 min, anchor 1 h, calendar upgrade 6 h. */
const LONG = 7 * HOUR

let dir = ''
let alertRuntime: InstanceType<typeof import('../src/main/services/alert-runtime').AlertRuntime>
let applier: ReturnType<typeof import('../src/main/config-apply').createConfigApplier>
let identity: import('../src/core/project-runtime').ProjectContext
let before: import('../src/core/config').RedLogConfig

function zero(): void { net.ntp = 0; net.dns = 0; net.calendars = 0; net.ipHttp = 0; net.update = 0; net.other = [] }

function deps(): import('../src/main/config-apply').ConfigApplyDeps {
  const nop = (): void => undefined
  return {
    isCurrent: (i) => i === identity,
    getShowWifiName: () => false, setShowWifiName: nop, publishLink: nop, broadcastIPStatus: nop,
    screenshotConfigure: nop, alertResetOnProjectSwitch: () => alertRuntime.resetOnProjectSwitch(),
    // As src/main/index.ts wires it.
    alertConfigure: (cfg, id, targets) => alertRuntime.configure(cfg, id, targets),
    lootConfigure: nop, configureCaptureHealth: nop, configureRedaction: nop, setVpnAdapters: nop, configureTerminal: nop,
    ingestCollaborators: () => ({}) as never, configureIngest: nop, configureFileWatcher: nop, configureConnectionMonitor: nop,
    configurePowershellTranscript: nop, configureProcessMonitor: nop, configureAgentTailer: nop,
    logConfigDiff: () => 'audit-row', proxyEndpoint: (c) => ({ host: c.httpCapture.listenHost, port: c.httpCapture.port }),
    proxyRunning: () => false, stopManagedHttpCapture: nop, startManagedHttpCapture: nop, scheduleScopeRecompute: nop,
    apiPort: () => 6660, lootDetector: {} as never, scopeDispatch: nop, hookExcludedPaths: () => [], listPlugins: () => [],
    agentCatalog: () => ({ catalog: [], modulePath: () => undefined }), homedir: () => os.tmpdir()
  }
}

/** The patch: write the file, apply it, as config:save does. */
function patchOffline(): void {
  const next = structuredClone(before)
  next.network.offline = true
  cfgMod.saveConfig(dir, next)
  applier.apply({ reason: 'save', identity, next, diskPrev: before, hooks: undefined } as never)
}

sqlite.describe('network.offline switched on while a project is open (Spec 073 T008)', () => {
  beforeEach(async () => {
    zero()
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url)
      if (u.includes('api.github.com')) net.update++
      else if (/ipify|ipinfo|my-ip/.test(u)) net.ipHttp++
      else net.other.push(u)
      throw new Error('no network in tests')
    })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-airgap-live-'))
    before = structuredClone(cfgMod.DEFAULT_CONFIG)
    before.engagement.id = 'eng-air'
    cfgMod.saveConfig(dir, before)
    dbMod.initDB(dir)
    dbMod.bindDBEngagement('eng-air')
    // A chain head for the anchor loop to find.
    for (let i = 0; i < 3; i++) evMod.insertEvent('system', { subtype: `seed_${i}` }, { operatorId: 'op' })

    identity = { projectId: 'p1', engagementId: 'eng-air', operatorId: 'op', generation: 1, signal: new AbortController().signal }
    alertRuntime = new alertMod.AlertRuntime({ engagementId: 'eng-air', operatorId: 'op' })
    applier = applyMod.createConfigApplier(deps())
    // The open, for the part of it that starts what air-gap must later stop.
    applier.apply({ reason: 'open', identity, next: before, hooks: undefined } as never)
    updater.setUpdaterAirgap(false)
    alertRuntime.start()
    clock.startNtpLoop()
    anchor.startAnchorLoop()
    await vi.advanceTimersByTimeAsync(0)
  })

  afterEach(() => {
    clock.stopNtpLoop(); anchor.stopAnchorLoop(); alertRuntime.stop()
    dbMod.closeDB()
    vi.useRealTimers(); vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** The update check as a person or the startup timer asks for it, on a platform that uses `fetch`. */
  async function checkUpdate(): Promise<void> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try { const p = updater.checkForUpdates({ manual: true }); await vi.advanceTimersByTimeAsync(10); await p } finally { Object.defineProperty(process, 'platform', platform) }
  }

  it('control: with air-gap off, every one of the four reaches the network double', async () => {
    await vi.advanceTimersByTimeAsync(LONG)
    expect(net.ntp, 'NTP').toBeGreaterThan(0)
    expect(net.calendars, 'anchor calendars').toBeGreaterThan(0)
    expect(net.dns + net.ipHttp, 'IP lookup').toBeGreaterThan(0)
    await checkUpdate()
    expect(net.update, 'update check').toBeGreaterThan(0)
    expect(net.other, 'requests to anywhere else').toEqual([])
  })

  // RED today: the NTP loop keeps its timers; the air-gap patch does not touch it.
  it.fails('NTP sends nothing after the patch', async () => {
    patchOffline(); zero()
    await vi.advanceTimersByTimeAsync(LONG)
    expect(net.ntp).toBe(0)
  })

  // RED today: the updater's air-gap flag is set at project open, not by a patch.
  it.fails('the update check makes no request after the patch', async () => {
    patchOffline(); zero()
    await checkUpdate()
    expect(net.update).toBe(0)
  })

  // Already true today: chain-anchor reads config.yaml on each call.
  it('anchoring sends nothing after the patch', async () => {
    patchOffline(); zero()
    await vi.advanceTimersByTimeAsync(LONG)
    expect(net.calendars).toBe(0)
  })

  // Already true today: the alertRuntime step reconfigures the IP producer with offline.
  it('the IP lookup sends nothing after the patch', async () => {
    patchOffline(); zero()
    await vi.advanceTimersByTimeAsync(LONG)
    expect(net.dns + net.ipHttp).toBe(0)
  })
})
