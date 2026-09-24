import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The two chokidar-backed capture sources that restart asynchronously: the
// file watcher and the PowerShell transcript follower. Each awaits the chokidar
// import before it creates a watcher, and config:save and project open
// configure them twice in one synchronous run. Two restarts used to interleave
// there: both created a watcher, only the second was kept, and the first kept
// firing — duplicate rows while the pack was on, capture after it was off.

const h = vi.hoisted(() => ({
  watchers: [] as Array<{ open: boolean; handlers: Map<string, Array<(p: string) => void>> }>,
  ingested: [] as unknown[]
}))

vi.mock('chokidar', () => {
  const watch = (): unknown => {
    const w = { open: true, handlers: new Map<string, Array<(p: string) => void>>() }
    h.watchers.push(w)
    const api = {
      on(event: string, cb: (p: string) => void) {
        if (event === 'ready') queueMicrotask(() => cb(''))
        else w.handlers.set(event, [...(w.handlers.get(event) ?? []), cb])
        return api
      },
      close: async () => { w.open = false }
    }
    return api
  }
  return { default: { watch }, watch }
})
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_type: string, data: unknown) => { h.ingested.push(data); return null },
  ingest: (input: unknown) => { h.ingested.push(input); return { event: null, companions: [] } }
}))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))

const IDS = { engagementId: 'eng', operatorId: 'op' }
const openWatchers = (): number => h.watchers.filter((w) => w.open).length
/** What chokidar would do on a filesystem change: tell every open watcher. */
const fire = (event: string, p: string): void => {
  for (const w of h.watchers) if (w.open) for (const cb of w.handlers.get(event) ?? []) cb(p)
}
/** Let every restart in flight finish. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

let home: string
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const restoreEnv = (key: 'HOME' | 'USERPROFILE'): void => {
  if (savedEnv[key] === undefined) delete process.env[key]
  else process.env[key] = savedEnv[key]
}

beforeEach(() => {
  vi.resetModules()
  h.watchers.length = 0
  h.ingested.length = 0
  // The transcript follower reads ~/.redlog/transcripts; keep it off the real one.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-watch-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  restoreEnv('HOME')
  restoreEnv('USERPROFILE')
  fs.rmSync(home, { recursive: true, force: true })
})

describe('file watcher — restarting', () => {
  let fw: typeof import('../src/main/services/file-watcher')
  const ON = { enabled: true, watchPaths: ['/watched'], ...IDS }
  // config:save in src/main/index.ts: the options, then applyCapturePacks.
  const save = (packOn: boolean): void => {
    void fw.configureFileWatcher({ watchPaths: ['/watched'], ignorePatterns: [], ...IDS })
    void fw.configureFileWatcher({ enabled: packOn })
  }

  beforeEach(async () => { fw = await import('../src/main/services/file-watcher') })
  afterEach(() => fw.stopFileWatcher())

  it('closes every watcher when a Settings save turns the pack off', async () => {
    await fw.configureFileWatcher(ON)
    save(false)
    await settle()
    expect(openWatchers()).toBe(0)
    fire('add', '/watched/created-after-the-pack-was-off.txt')
    expect(h.ingested).toHaveLength(0)
  })

  it('keeps one watcher, and one row per change, across saves with the pack on', async () => {
    await fw.configureFileWatcher(ON)
    save(true)
    save(true)
    await settle()
    expect(openWatchers()).toBe(1)
    fire('add', '/watched/new.txt')
    expect(h.ingested).toHaveLength(1)
  })

  it('closes the watcher when a project with the pack off opens after one with it on', async () => {
    await fw.configureFileWatcher(ON)
    // stopProject, then startProject: configure, then applyCapturePacks.
    fw.stopFileWatcher()
    void fw.configureFileWatcher({ watchPaths: ['/watched'], ignorePatterns: [], engagementId: 'eng2', operatorId: 'op2' })
    void fw.configureFileWatcher({ enabled: false })
    await settle()
    expect(openWatchers()).toBe(0)
  })
})

describe('PowerShell transcript follower — restarting', () => {
  let pt: typeof import('../src/main/services/powershell-transcript')
  // stopProject, then startProject: configure (src/main/index.ts), then
  // applyCapturePacks switches the pack. config:save calls it only once.
  const switchProject = (packOn: boolean): void => {
    pt.stopPowershellTranscript()
    void pt.configurePowershellTranscript({ engagementId: 'eng2', operatorId: 'op2' })
    void pt.configurePowershellTranscript({ enabled: packOn })
  }

  beforeEach(async () => { pt = await import('../src/main/services/powershell-transcript') })
  afterEach(() => pt.stopPowershellTranscript())

  it('stops following when a project with the pack off opens after one with it on', async () => {
    await pt.configurePowershellTranscript({ enabled: true, ...IDS })
    switchProject(false)
    await settle()
    expect(openWatchers()).toBe(0)

    const dir = path.join(home, '.redlog', 'transcripts')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.txt')
    fs.writeFileSync(file, [
      '**********************',
      'Windows PowerShell transcript start',
      'Start time: 20260924120000',
      'Machine: DESKTOP-7',
      '**********************',
      'PS C:\\> whoami',
      'desktop\\operator'
    ].join('\n'))
    fire('change', file)
    expect(h.ingested).toHaveLength(0)
  })

  it('keeps one follower when a project with the pack on opens after another', async () => {
    await pt.configurePowershellTranscript({ enabled: true, ...IDS })
    switchProject(true)
    await settle()
    expect(openWatchers()).toBe(1)
  })
})
