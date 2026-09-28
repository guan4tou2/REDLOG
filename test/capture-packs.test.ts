import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig } from '../src/core/config'

// Spec 035 — optional capture comes in packs. A pack runs only when the
// project turns it on and its bundled plugin is active; the per-source
// `enabled` keys are gone.

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const MEMBER_KEYS = ['clipboard', 'fileWatcher', 'processMonitor', 'connectionMonitor', 'powershellTranscript', 'agentTailer']

describe('capture packs: config', () => {
  it('ships every pack off, and no source has its own enabled switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-packs-'))
    try {
      const c = loadConfig(dir) as unknown as Record<string, Record<string, unknown>>
      expect(c.packs).toEqual({ hostMonitors: false, aiAgents: false, windowsOutput: false })
      for (const k of MEMBER_KEYS) expect({ k, enabled: c[k]?.enabled }).toEqual({ k, enabled: undefined })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('reads nothing from the removed keys', () => {
    for (const file of ['src/main/index.ts', 'src/core/capture-health.ts', 'src/main/config-audit.ts',
      'src/renderer/src/components/settings/CaptureControlPage.tsx', 'src/renderer/src/components/settings/AgentsPanel.tsx']) {
      const src = read(file)
      for (const k of MEMBER_KEYS) {
        expect({ file, k, reads: new RegExp(`\\b${k}\\??\\.enabled\\b`).test(src) }).toEqual({ file, k, reads: false })
      }
    }
  })

  it('ships a bundled plugin manifest for each pack', () => {
    for (const id of ['pack-host-monitors', 'pack-ai-agents', 'pack-windows-output']) {
      const m = JSON.parse(read(`plugins/${id}/plugin.json`)) as { id: string; kind: string }
      expect(m).toMatchObject({ id, kind: 'pack' })
    }
  })
})

describe('capture packs: isPackOn', async () => {
  const { isPackOn, CAPTURE_PACKS } = await import('../src/core/capture-packs')
  const plugin = (id: string, status: string) => ({ manifest: { id }, source: 'bundled', status }) as never

  it('needs both the project switch and an active bundled plugin', () => {
    const on = { packs: { hostMonitors: true } }
    const active = [plugin(CAPTURE_PACKS.hostMonitors.pluginId, 'active')]
    expect(isPackOn(on, 'hostMonitors', active)).toBe(true)
    expect(isPackOn({ packs: { hostMonitors: false } }, 'hostMonitors', active)).toBe(false)
    expect(isPackOn(on, 'hostMonitors', [plugin(CAPTURE_PACKS.hostMonitors.pluginId, 'disabled')])).toBe(false)
    expect(isPackOn(on, 'hostMonitors', [])).toBe(false)
  })

  it('names its members', () => {
    expect(CAPTURE_PACKS.hostMonitors.members).toEqual(['processMonitor', 'connectionMonitor', 'fileWatcher', 'clipboard'])
    expect(CAPTURE_PACKS.aiAgents.members).toEqual(['agentTailer'])
    expect(CAPTURE_PACKS.windowsOutput.members).toEqual(['powershellTranscript'])
  })
})

describe('capture packs: isPackMemberOn', async () => {
  const { isPackMemberOn, packOfMember, CAPTURE_PACKS } = await import('../src/core/capture-packs')
  const plugin = (id: string, status: string) => ({ manifest: { id }, source: 'bundled', status }) as never
  const active = [
    plugin(CAPTURE_PACKS.hostMonitors.pluginId, 'active'),
    plugin(CAPTURE_PACKS.aiAgents.pluginId, 'active')
  ]

  it('lets the operator drop one member without losing the pack', () => {
    // The clipboard is why this exists. It samples whatever the operator
    // copies anywhere on the machine for the length of the engagement, and
    // bundling it with three host monitors made the answer to "I want process
    // and connection monitoring but not my clipboard" be "then have neither".
    const cfg = { packs: { hostMonitors: true }, packMembers: { clipboard: false } }
    expect(isPackMemberOn(cfg, 'clipboard', active)).toBe(false)
    expect(isPackMemberOn(cfg, 'processMonitor', active)).toBe(true)
    expect(isPackMemberOn(cfg, 'connectionMonitor', active)).toBe(true)
    expect(isPackMemberOn(cfg, 'fileWatcher', active)).toBe(true)
  })

  it('turns the ordinary members on with the pack, and never the clipboard (#224)', () => {
    // An unset switch follows the member's default. The pack stays a preset
    // for process, connection and file monitoring; the clipboard samples
    // whatever the operator copies anywhere on the machine, so it records
    // only when ticked — turning the pack on is not deciding to collect it.
    for (const cfg of [{ packs: { hostMonitors: true } }, { packs: { hostMonitors: true }, packMembers: {} }]) {
      expect(isPackMemberOn(cfg, 'clipboard', active)).toBe(false)
      expect(isPackMemberOn(cfg, 'processMonitor', active)).toBe(true)
      expect(isPackMemberOn(cfg, 'connectionMonitor', active)).toBe(true)
      expect(isPackMemberOn(cfg, 'fileWatcher', active)).toBe(true)
    }
  })

  it('keeps an explicit choice either way, with no migration', () => {
    const pack = { hostMonitors: true }
    expect(isPackMemberOn({ packs: pack, packMembers: { clipboard: true } }, 'clipboard', active)).toBe(true)
    expect(isPackMemberOn({ packs: pack, packMembers: { clipboard: false } }, 'clipboard', active)).toBe(false)
    expect(isPackMemberOn({ packs: pack, packMembers: { fileWatcher: false } }, 'fileWatcher', active)).toBe(false)
  })

  it('leaves AI agents off until their pack is turned on', () => {
    expect(isPackMemberOn({}, 'agentTailer', active)).toBe(false)
    expect(isPackMemberOn({ packs: { aiAgents: true } }, 'agentTailer', active)).toBe(true)
  })

  it('never runs a member whose pack is off, or whose plugin is gone', () => {
    // A member switch cannot opt into a pack the operator has not turned on,
    // or one whose plugin was disabled in Plugins.
    expect(isPackMemberOn({ packs: { hostMonitors: false }, packMembers: { clipboard: true } }, 'clipboard', active)).toBe(false)
    expect(isPackMemberOn({ packs: { hostMonitors: true }, packMembers: { clipboard: true } }, 'clipboard', [])).toBe(false)
  })

  it('maps every declared member back to its pack', () => {
    expect(packOfMember('clipboard')).toBe('hostMonitors')
    expect(packOfMember('agentTailer')).toBe('aiAgents')
    expect(packOfMember('powershellTranscript')).toBe('windowsOutput')
  })
})

let db: typeof import('../src/core/db/index')
let ch: typeof import('../src/core/capture-health')
let pluginsIndex: typeof import('../src/core/plugins/index')
let dbAvailable = false
try {
  db = await import('../src/core/db/index')
  ch = await import('../src/core/capture-health')
  pluginsIndex = await import('../src/core/plugins/index')
  dbAvailable = true
} catch { /* native module unavailable */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('capture packs: health', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-packs-db-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const bundled = (id: string, status = 'active') => ({ manifest: { id }, source: 'bundled', status }) as never
  const allPacks = [bundled('pack-host-monitors'), bundled('pack-ai-agents'), bundled('pack-windows-output')]

  it('switches a member row through its pack', () => {
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: true } })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    // A member's own switch, plus the pack it belongs to. Turning the member
    // on has to set both, or the operator flips a switch and the row stays off.
    expect(rows.find((s) => s.id === 'process-monitor')).toMatchObject({
      configPath: 'packMembers.processMonitor', packPath: 'packs.hostMonitors', enabled: true
    })
    expect(rows.find((s) => s.id === 'agent-tailer')).toMatchObject({
      configPath: 'packMembers.agentTailer', packPath: 'packs.aiAgents', enabled: false
    })
  })

  it('reports a member the operator opted out of as off, with its pack still on', () => {
    // A pack is a preset, not an atom: "Host monitors" bundles four sources
    // and the clipboard is not like the other three. All-or-nothing meant an
    // operator who wanted process and connection monitoring took a full-time
    // sample of everything they copied along with it.
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: { clipboard: false } })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'clipboard')).toMatchObject({ enabled: false, state: 'off' })
    // The rest of the pack is untouched — that is the whole point.
    for (const still of ['process-monitor', 'connection-monitor', 'file-watcher']) {
      expect(rows.find((s) => s.id === still), still).toMatchObject({ enabled: true })
    }
  })

  it('reports the clipboard off until ticked, and the rest of the pack on (#224)', () => {
    // Capture Health must read the same rule the runtime uses, or the card
    // says "on" for a source that is not running.
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: {} })
    ch.invalidateHooksCache()
    let rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'clipboard')).toMatchObject({ enabled: false, state: 'off' })
    for (const on of ['process-monitor', 'connection-monitor', 'file-watcher']) {
      expect(rows.find((s) => s.id === on), on).toMatchObject({ enabled: true })
    }
    ch.configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: { clipboard: true } })
    ch.invalidateHooksCache()
    rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'clipboard')).toMatchObject({ enabled: true })
  })

  it('keeps a member off while its pack is off, whatever the member says', () => {
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: false }, packMembers: { clipboard: true } })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'clipboard')).toMatchObject({ enabled: false, state: 'off' })
  })

  it('drops the rows of a pack whose plugin is not active', () => {
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([
      bundled('pack-host-monitors', 'disabled'), bundled('pack-ai-agents'), bundled('pack-windows-output')
    ])
    ch.configureCaptureHealth({ packs: { hostMonitors: true } })
    ch.invalidateHooksCache()
    const ids = ch.getCaptureHealth().sources.map((s) => s.id)
    for (const gone of ['process-monitor', 'connection-monitor', 'file-watcher', 'clipboard']) expect(ids).not.toContain(gone)
    expect(ids).toContain('agent-tailer')
    expect(ids).toContain('shell-hook')
  })
})
