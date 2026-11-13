import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { requires } from './helpers/requires'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig } from '../src/core/config'

// Spec 035 — optional capture comes in packs. A pack runs only when the
// project turns it on and its bundled plugin is active; the per-source
// `enabled` keys are gone.

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const MEMBER_KEYS = ['fileWatcher', 'processMonitor', 'connectionMonitor', 'powershellTranscript', 'agentTailer']

describe('capture packs: config', () => {
  it('ships every pack off, and no source has its own enabled switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-packs-'))
    try {
      const c = loadConfig(dir) as unknown as Record<string, Record<string, unknown>>
      expect(c.packs).toEqual({ hostMonitors: false, windowsOutput: false })
      for (const k of MEMBER_KEYS) expect({ k, enabled: c[k]?.enabled }).toEqual({ k, enabled: undefined })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('opens a config that still holds keys of a removed source', () => {
    // The clipboard monitor was removed. A key RedLog no longer reads is
    // unknown, not invalid.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-packs-'))
    try {
      fs.writeFileSync(path.join(dir, 'config.yaml'),
        'clipboard:\n  pollMs: 1500\n  storePreview: true\npackMembers:\n  clipboard: true\n')
      expect(() => loadConfig(dir)).not.toThrow()
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
    for (const id of ['pack-host-monitors', 'pack-windows-output']) {
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
    expect(CAPTURE_PACKS.hostMonitors.members).toEqual(['processMonitor', 'connectionMonitor', 'fileWatcher'])
    expect(CAPTURE_PACKS).not.toHaveProperty('aiAgents')
    expect(CAPTURE_PACKS.windowsOutput.members).toEqual(['powershellTranscript'])
  })
})

describe('capture packs: isPackMemberOn', async () => {
  const { isPackMemberOn, packOfMember, CAPTURE_PACKS } = await import('../src/core/capture-packs')
  const plugin = (id: string, status: string) => ({ manifest: { id }, source: 'bundled', status }) as never
  const active = [
    plugin(CAPTURE_PACKS.hostMonitors.pluginId, 'active')
  ]

  it('lets the operator drop one member without losing the pack', () => {
    const cfg = { packs: { hostMonitors: true }, packMembers: { fileWatcher: false } }
    expect(isPackMemberOn(cfg, 'fileWatcher', active)).toBe(false)
    expect(isPackMemberOn(cfg, 'processMonitor', active)).toBe(true)
    expect(isPackMemberOn(cfg, 'connectionMonitor', active)).toBe(true)
  })

  it('turns every member on with the pack', () => {
    for (const cfg of [{ packs: { hostMonitors: true } }, { packs: { hostMonitors: true }, packMembers: {} }]) {
      expect(isPackMemberOn(cfg, 'processMonitor', active)).toBe(true)
      expect(isPackMemberOn(cfg, 'connectionMonitor', active)).toBe(true)
      expect(isPackMemberOn(cfg, 'fileWatcher', active)).toBe(true)
    }
  })

  it('keeps an explicit choice either way', () => {
    const pack = { hostMonitors: true }
    expect(isPackMemberOn({ packs: pack, packMembers: { fileWatcher: true } }, 'fileWatcher', active)).toBe(true)
    expect(isPackMemberOn({ packs: pack, packMembers: { fileWatcher: false } }, 'fileWatcher', active)).toBe(false)
  })

  it('never runs a member whose pack is off, or whose plugin is gone', () => {
    // A member switch cannot opt into a pack the operator has not turned on,
    // or one whose plugin was disabled in Plugins.
    expect(isPackMemberOn({ packs: { hostMonitors: false }, packMembers: { fileWatcher: true } }, 'fileWatcher', active)).toBe(false)
    expect(isPackMemberOn({ packs: { hostMonitors: true }, packMembers: { fileWatcher: true } }, 'fileWatcher', [])).toBe(false)
  })

  it('maps every declared member back to its pack', () => {
    expect(packOfMember('fileWatcher')).toBe('hostMonitors')
    expect(packOfMember('powershellTranscript')).toBe('windowsOutput')
  })
})

let db: typeof import('../src/core/db/index')
let ch: typeof import('../src/core/capture-health')
let pluginsIndex: typeof import('../src/core/plugins/index')
let dbAvailable = false
if (requires('better-sqlite3').ok) {
  db = await import('../src/core/db/index')
  ch = await import('../src/core/capture-health')
  pluginsIndex = await import('../src/core/plugins/index')
  dbAvailable = true
}
const describeDB = dbAvailable ? describe : describe.skip

describeDB('capture packs: health', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-packs-db-')); db.initDB(dir) })
  afterEach(() => { vi.restoreAllMocks(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const bundled = (id: string, status = 'active') => ({ manifest: { id }, source: 'bundled', status }) as never
  const allPacks = [bundled('pack-host-monitors'), bundled('pack-windows-output')]

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
    for (const id of ['agent-claude-code', 'agent-codex']) {
      expect(rows.find((s) => s.id === id)).toMatchObject({
        installed: false, enabled: false, state: 'off'
      })
    }
  })

  it('reports a member the operator opted out of as off, with its pack still on', () => {
    // A pack is a preset, not an atom.
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: { fileWatcher: false } })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'file-watcher')).toMatchObject({ enabled: false, state: 'off' })
    // The rest of the pack is untouched — that is the whole point.
    for (const still of ['process-monitor', 'connection-monitor']) {
      expect(rows.find((s) => s.id === still), still).toMatchObject({ enabled: true })
    }
  })

  it('reports every member on with the pack when nothing was unticked', () => {
    // Capture Health must read the same rule the runtime uses, or the card
    // says "on" for a source that is not running.
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: true }, packMembers: {} })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    for (const on of ['process-monitor', 'connection-monitor', 'file-watcher']) {
      expect(rows.find((s) => s.id === on), on).toMatchObject({ enabled: true })
    }
    expect(rows.find((s) => s.id === 'clipboard')).toBeUndefined()
  })

  it('keeps a member off while its pack is off, whatever the member says', () => {
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(allPacks)
    ch.configureCaptureHealth({ packs: { hostMonitors: false }, packMembers: { fileWatcher: true } })
    ch.invalidateHooksCache()
    const rows = ch.getCaptureHealth().sources
    expect(rows.find((s) => s.id === 'file-watcher')).toMatchObject({ enabled: false, state: 'off' })
  })

  it('drops the rows of a pack whose plugin is not active', () => {
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([
      bundled('pack-host-monitors', 'disabled'), bundled('pack-windows-output')
    ])
    ch.configureCaptureHealth({ packs: { hostMonitors: true } })
    ch.invalidateHooksCache()
    const ids = ch.getCaptureHealth().sources.map((s) => s.id)
    for (const gone of ['process-monitor', 'connection-monitor', 'file-watcher']) expect(ids).not.toContain(gone)
    expect(ids).toContain('agent-claude-code')
    expect(ids).toContain('terminal')
  })
})
