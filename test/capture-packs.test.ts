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
    expect(rows.find((s) => s.id === 'process-monitor')).toMatchObject({ configPath: 'packs.hostMonitors', enabled: true })
    expect(rows.find((s) => s.id === 'agent-tailer')).toMatchObject({ configPath: 'packs.aiAgents', enabled: false })
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
