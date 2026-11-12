import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ProbeFs } from '../src/core/agent-activity-probe'

// "An AI tool is in use on this machine and is not being recorded" — the
// health half. Temp directories only: HOME is a temp dir and the vendor
// environment variables are cleared, so nothing here reaches the real
// ~/.claude or ~/.codex.

let dbAvailable = false
let db: typeof import('../src/core/db/index')
let health: typeof import('../src/core/capture-health')
let hooksMod: typeof import('../src/core/hooks-manager')
let pluginsIndex: typeof import('../src/core/plugins/index')
let bus: typeof import('../src/core/event-bus')
let official: typeof import('../src/core/plugins/official-agents')
let issueRoute: typeof import('../src/renderer/src/lib/captureIssue')
try {
  db = await import('../src/core/db/index')
  health = await import('../src/core/capture-health')
  hooksMod = await import('../src/core/hooks-manager')
  pluginsIndex = await import('../src/core/plugins/index')
  bus = await import('../src/core/event-bus')
  official = await import('../src/core/plugins/official-agents')
  issueRoute = await import('../src/renderer/src/lib/captureIssue')
  dbAvailable = true
} catch { /* better-sqlite3 not built */ }

const describeDB = dbAvailable ? describe : describe.skip

function counting(): ProbeFs & { calls: number } {
  const c = {
    calls: 0,
    stat: (p: string) => { c.calls++; return fsp.stat(p) },
    lstat: (p: string) => { c.calls++; return fsp.lstat(p) },
    readdir: (p: string, o: { withFileTypes: true }) => { c.calls++; return fsp.readdir(p, o) }
  }
  return c
}

function touch(p: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

describeDB('capture health — AI tool in use, not recorded', () => {
  let home: string, project: string, probeFs: ReturnType<typeof counting>
  let probe: import('../src/core/agent-activity-probe').ActivityProbe | null
  const codexSession = (): string => path.join(home, '.codex', 'sessions', '2026', '11', '12', 'rollout-a.jsonl')
  const row = (h: import('../src/core/capture-health').CaptureHealth, id: string) => h.sources.find((s) => s.id === id)

  /** Read health, let the background walk finish, read again. */
  async function read(): Promise<import('../src/core/capture-health').CaptureHealth> {
    health.getCaptureHealth()
    await probe?.settle()
    return health.getCaptureHealth()
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-home-'))
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-proj-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    vi.stubEnv('CODEX_HOME', '')
    health.invalidateHooksCache()
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([])
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([])
    db.initDB(project)
    health.configureCaptureHealth({})
    probeFs = counting()
    probe = health._configureAgentActivityProbe({ fs: probeFs })
  })
  afterEach(() => {
    health._configureAgentActivityProbe(null)
    bus.eventBus.resume()
    db.closeDB()
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
  })

  it('no transcript directory: nothing', async () => {
    const h = await read()
    expect(h.sources.some((s) => s.unrecordedActivityAt != null)).toBe(false)
  })

  it('a directory with only old files: nothing', async () => {
    touch(codexSession(), Date.now() - 2 * 24 * 3600_000)
    expect(row(await read(), 'agent-codex')?.unrecordedActivityAt).toBeUndefined()
  })

  it('a fresh session under a tool that is not set up: reported on that row only', async () => {
    touch(codexSession(), Date.now() - 30_000)
    const h = await read()
    expect(row(h, 'agent-codex')?.unrecordedActivityAt).toEqual(expect.any(Number))
    expect(row(h, 'agent-codex')?.state).toBe('off')
    expect(row(h, 'agent-claude-code')?.unrecordedActivityAt).toBeUndefined()
  })

  it('does not change the verdict, any state, or where the status bar issue leads', async () => {
    const before = await read()
    touch(codexSession(), Date.now() - 30_000)
    health._configureAgentActivityProbe(null); probe = health._configureAgentActivityProbe({ fs: probeFs })
    const after = await read()
    expect(row(after, 'agent-codex')?.unrecordedActivityAt).toEqual(expect.any(Number))
    expect(after.verdict).toBe(before.verdict)
    expect(after.sources.map((s) => [s.id, s.state])).toEqual(before.sources.map((s) => [s.id, s.state]))
    expect(issueRoute.captureIssueView(after)).toBe(issueRoute.captureIssueView(before))
  })

  it('a source that is enabled and recording: nothing', async () => {
    const manager = official.createOfficialAgentPluginManager(path.join(home, '.redlog', 'plugins'))
    manager.install('codex')
    touch(codexSession(), Date.now() - 30_000)
    const installationId = manager.list().find((p) => p.agentKind === 'codex')!.installationId
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([{ manifest: { id: 'official-ai-codex' }, status: 'active' }] as never)
    health.configureCaptureHealth({ agentTailer: { sources: { codex: { enabled: true, installationId, workPaths: [home], startedAt: 1000 } } } })
    const h = await read()
    expect(row(h, 'agent-codex')).toMatchObject({ enabled: true, state: 'ready' })
    expect(row(h, 'agent-codex')?.unrecordedActivityAt).toBeUndefined()
  })

  it('a source that is enabled and failing: the existing error row only', async () => {
    const manager = official.createOfficialAgentPluginManager(path.join(home, '.redlog', 'plugins'))
    manager.install('codex')
    touch(codexSession(), Date.now() - 30_000)
    const installationId = manager.list().find((p) => p.agentKind === 'codex')!.installationId
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([{ manifest: { id: 'official-ai-codex' }, status: 'active' }] as never)
    health.configureCaptureHealth({ agentTailer: { sources: { codex: { enabled: true, installationId, workPaths: [home], startedAt: 1000 } } } })
    health.noteCaptureError('agent-codex', new Error('tail failed'))
    const h = await read()
    expect(row(h, 'agent-codex')?.state).toBe('error')
    expect(row(h, 'agent-codex')?.unrecordedActivityAt).toBeUndefined()
    health.clearCaptureError('agent-codex')
  })

  it('a source whose integration is broken (an error row, not enabled): the error only', async () => {
    fs.mkdirSync(path.join(home, '.redlog', 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(home, '.redlog', 'plugins', 'official-ai-codex'), '')
    touch(codexSession(), Date.now() - 30_000)
    const h = await read()
    expect(row(h, 'agent-codex')?.state).toBe('error')
    expect(row(h, 'agent-codex')?.unrecordedActivityAt).toBeUndefined()
  })

  it('recording paused: nothing, and no walk', async () => {
    touch(codexSession(), Date.now() - 30_000)
    bus.eventBus.pause()
    const h = await read()
    expect(h.sources.some((s) => s.unrecordedActivityAt != null)).toBe(false)
    expect(probeFs.calls).toBe(0)
  })

  it('no project open: no health, and no walk', () => {
    touch(codexSession(), Date.now() - 30_000)
    db.closeDB()
    expect(() => health.getCaptureHealth(Date.now() + 10_000)).toThrow()
    expect(probeFs.calls).toBe(0)
    db.initDB(project)
  })

  it('a second snapshot within the interval walks nothing', async () => {
    touch(codexSession(), Date.now() - 30_000)
    await read()
    const calls = probeFs.calls
    expect(calls).toBeGreaterThan(0)
    health.getCaptureHealth(Date.now() + 5_000)
    health.getCaptureHealth(Date.now() + 20_000)
    await probe?.settle()
    expect(probeFs.calls).toBe(calls)
  })

  it('is off by default outside the app, so a test never walks a real home', async () => {
    health._configureAgentActivityProbe(undefined)
    probe = null
    touch(codexSession(), Date.now() - 30_000)
    const h = await read()
    expect(h.sources.some((s) => s.unrecordedActivityAt != null)).toBe(false)
  })
})
