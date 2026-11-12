// A config.yaml that is there but cannot be used is never replaced by the
// defaults, and nothing acts on the defaults in its place. Absent is the one
// case where the defaults are the answer: that is a project's first open.
//
// What used to happen: `loadConfig` turned any read or parse error into the
// defaults, and the open wrote them straight back — scope, network policy,
// operator and `engagement.id` (which became `default`) were gone, and the
// project then bound itself to `default`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ answer: 0 }))
vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn(async () => ({ response: h.answer })), showOpenDialog: vi.fn() }
}))

import * as config from '../src/core/config'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/core/config'
import * as invalidTag from '../src/core/config-invalid'
import { createConfigStore } from '../src/main/config-store'
import type { ProjectContext } from '../src/core/project-runtime'
import { initDB, closeDB } from '../src/core/db/index'
import { getEventCount } from '../src/core/db/events'
import { _resetIngest } from '../src/core/ingest'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import { registerArtifactsIpc } from '../src/main/ipc/artifacts'
import { registerTargetContextIpc } from '../src/main/ipc/target-context'
import type { IpcContext } from '../src/main/ipc/types'
import en from '../src/renderer/src/i18n/en.json'
import zhTW from '../src/renderer/src/i18n/zh-TW.json'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

const VALID = 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n  name: Ana\nscope:\n  targets:\n    - in.test\n'
// Each one is a file an operator can end up with: a hand edit with a typo, a
// merge left half done, a list pasted at the top level, a stray scalar, a
// save cut off before its first byte.
const INVALID: Array<[string, string]> = [
  ['unparseable YAML', 'engagement:\n  id: eng-1\noperator:\n  id: [op-1\n'],
  ['a merge marker', 'engagement:\n<<<<<<< HEAD\n  id: eng-1\n=======\n  id: eng-2\n>>>>>>> other\n'],
  ['a top-level list', '- in.test\n- other.test\n'],
  ['a top-level scalar', 'just some text\n'],
  ['an empty file', '']
]

let dir: string
const file = (): string => path.join(dir, 'config.yaml')
const bytes = (): Buffer => fs.readFileSync(file())
const strays = (): string[] => fs.readdirSync(dir).filter((n) => n !== 'config.yaml' && n.includes('config.yaml'))

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-invalid-')) })
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reading config.yaml', () => {
  it('says absent, with the defaults, when there is no file', () => {
    const read = config.readConfig(dir)
    expect(read.kind).toBe('absent')
    expect(read.kind === 'absent' && read.config).toEqual(DEFAULT_CONFIG)
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG)
  })

  it('merges a valid file over the defaults, as before', () => {
    fs.writeFileSync(file(), VALID)
    const read = config.readConfig(dir)
    expect(read.kind).toBe('ok')
    const c = loadConfig(dir)
    expect(c.engagement.id).toBe('eng-1')
    expect(c.operator).toEqual({ id: 'op-1', name: 'Ana' })
    expect(c.scope.targets).toEqual(['in.test'])
    expect(c.network).toEqual(DEFAULT_CONFIG.network)
  })

  for (const [name, text] of INVALID) {
    it(`calls ${name} invalid, and loadConfig refuses it instead of returning defaults`, () => {
      fs.writeFileSync(file(), text)
      const read = config.readConfig(dir)
      expect(read.kind).toBe('invalid')
      expect(() => loadConfig(dir)).toThrow(config.ConfigInvalidError)
    })
  }

  it('calls a config.yaml that cannot be read as a file invalid, not absent', () => {
    fs.mkdirSync(file())
    expect(config.readConfig(dir).kind).toBe('invalid')
    expect(() => loadConfig(dir)).toThrow(config.ConfigInvalidError)
  })

  it('names the file and the reason, behind a tag that survives IPC', () => {
    fs.writeFileSync(file(), '- a\n')
    let message = ''
    try { loadConfig(dir) } catch (e) { message = (e as Error).message }
    // Electron passes only the message across IPC, prefixed with its own text.
    const detail = invalidTag.configInvalidDetail(`Error invoking remote method 'project:open': Error: ${message}`)
    expect(detail).toContain(file())
    expect(detail).toMatch(/not a mapping/)
    expect(invalidTag.configInvalidDetail("Error invoking remote method 'project:open': Error: SQLITE_BUSY")).toBeNull()
  })
})

describe('opening a project (prepareOpenConfig, called by startProject before anything is closed)', () => {
  for (const [name, text] of INVALID) {
    it(`refuses ${name} and leaves the file byte for byte`, () => {
      fs.writeFileSync(file(), text)
      const before = bytes()
      expect(() => config.prepareOpenConfig(dir)).toThrow(config.ConfigInvalidError)
      expect(bytes()).toEqual(before)
      expect(strays()).toEqual([])
    })
  }

  it('writes the defaults on a first open, as today', () => {
    const c = config.prepareOpenConfig(dir)
    expect(c).toEqual(DEFAULT_CONFIG)
    expect(fs.existsSync(file())).toBe(true)
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG)
  })

  it('keeps a valid file\'s values and writes back the merged form, as today', () => {
    fs.writeFileSync(file(), VALID)
    const c = config.prepareOpenConfig(dir)
    expect(c.engagement.id).toBe('eng-1')
    expect(c.operator.id).toBe('op-1')
    expect(loadConfig(dir)).toEqual(c)
  })

  it('is read before the open project is stopped or the new identity bound', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('function startProject('), src.indexOf('function startProjectResources('))
    const prepared = body.indexOf('prepareOpenConfig(projectDir)')
    expect(prepared).toBeGreaterThan(0)
    expect(prepared).toBeLessThan(body.indexOf('stopProject()'))
    expect(prepared).toBeLessThan(body.indexOf('projectRuntime.begin('))
    // And the open no longer reads and writes the file itself.
    expect(body).not.toMatch(/saveConfig\(/)
  })

  it('tells the operator which file and why, in both locales', () => {
    expect((en as Record<string, string>)['project.openFailedConfigWhy']).toBeTruthy()
    expect((zhTW as Record<string, string>)['project.openFailedConfigWhy']).toBeTruthy()
  })
})

describe('saving config.yaml is whole or not at all', () => {
  it('keeps the old bytes when the write is cut off', () => {
    fs.writeFileSync(file(), VALID)
    const before = bytes()
    const real = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string, opts?: fs.WriteFileOptions) => {
      real(target, String(data).slice(0, 12), opts)
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }) as typeof fs.writeFileSync)
    const next = loadConfig(dir)
    next.scope.targets = ['changed.test']
    expect(() => saveConfig(dir, next)).toThrow(/ENOSPC/)
    expect(bytes()).toEqual(before)
    expect(strays()).toEqual([])
  })

  it('keeps the old bytes when the rename fails, and leaves no temp file', () => {
    fs.writeFileSync(file(), VALID)
    const before = bytes()
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    })
    const next = loadConfig(dir)
    next.scope.targets = ['changed.test']
    expect(() => saveConfig(dir, next)).toThrow(/EXDEV/)
    expect(bytes()).toEqual(before)
    expect(strays()).toEqual([])
  })

  // The rename would succeed over it (only the directory's mode matters to a
  // rename); the in-place write it replaces refused, and Settings' save-failure
  // path is exercised that way (e2e/capture-settings-interaction.spec.ts).
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('still refuses a target the owner made read-only', () => {
    fs.writeFileSync(file(), VALID)
    fs.chmodSync(file(), 0o444)
    const before = bytes()
    const next = loadConfig(dir)
    next.scope.targets = ['changed.test']
    expect(() => saveConfig(dir, next)).toThrow(/EACCES/)
    expect(bytes()).toEqual(before)
    expect(strays()).toEqual([])
    fs.chmodSync(file(), 0o600)
  })

  it.skipIf(process.platform === 'win32')('leaves the file owner-only', () => {
    fs.writeFileSync(file(), VALID, { mode: 0o644 })
    saveConfig(dir, loadConfig(dir))
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
  })
})

describe('writers refuse an invalid file instead of saving defaults over it', () => {
  const ctx: ProjectContext = { projectId: 'p', engagementId: 'eng-1', operatorId: 'op-1', generation: 1, signal: new AbortController().signal }
  const store = (applied: unknown[]) => createConfigStore({
    projectDir: () => dir, identity: () => ctx,
    resolveOperator: (_prev, next) => next,
    apply: (r) => { applied.push(r) }
  })

  it('a Settings patch', () => {
    fs.writeFileSync(file(), INVALID[0][1])
    const before = bytes()
    const applied: unknown[] = []
    expect(() => store(applied).patch({ ops: [{ path: ['network', 'checkInterval'], value: 45, base: 60 }] }))
      .toThrow(config.ConfigInvalidError)
    expect(bytes()).toEqual(before)
    expect(applied).toEqual([])
  })

  it('a whole-object save', () => {
    fs.writeFileSync(file(), INVALID[2][1])
    const before = bytes()
    const applied: unknown[] = []
    expect(() => store(applied).saveWhole({ network: { checkInterval: 45 } })).toThrow(config.ConfigInvalidError)
    expect(bytes()).toEqual(before)
    expect(applied).toEqual([])
  })

  it('the current-target switch', () => {
    fs.writeFileSync(file(), INVALID[0][1])
    const before = bytes()
    const handlers = new Map<string, Handler>()
    const commit = vi.fn(() => true)
    const ipc = {
      getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }),
      getCurrentEngagementId: () => 'eng-1', getCurrentOperatorId: () => 'op-1',
      send: vi.fn(), getMainWindow: () => null, getOverlayWindow: () => null
    } as unknown as IpcContext
    registerTargetContextIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ipc, { commit })
    expect(() => handlers.get('targetContext:set')!({}, '10.0.0.5')).toThrow(config.ConfigInvalidError)
    expect(commit).not.toHaveBeenCalled()
    expect(bytes()).toEqual(before)
  })
})

describe('nothing is recorded under the defaults\' identity', () => {
  let handlers: Map<string, Handler>
  beforeEach(() => {
    fs.writeFileSync(file(), VALID)
    initDB(dir)
    _resetIngest()
    handlers = new Map()
    const ipc = {
      getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }),
      getMainWindow: () => ({})
    } as unknown as IpcContext
    const reg = { handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never
    registerMarkersIpc(reg, ipc, {} as never)
    registerArtifactsIpc(reg, ipc)
    // Valid at open, broken by a hand edit while the project is open.
    fs.writeFileSync(file(), INVALID[0][1])
  })
  afterEach(() => { closeDB() })

  it('a marker is refused, not written as operator-1 of engagement default', () => {
    const count = getEventCount()
    expect(() => handlers.get('marker:create')!({}, { title: 'note' })).toThrow(config.ConfigInvalidError)
    expect(() => handlers.get('marker:amend')!({}, 'm1', { title: 'x' })).toThrow(config.ConfigInvalidError)
    expect(getEventCount()).toBe(count)
  })

  it('a dropped evidence file is refused before it is copied in', async () => {
    const loot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-invalid-loot-'))
    try {
      fs.writeFileSync(path.join(loot, 'hashes.txt'), 'admin:aad3b435')
      const count = getEventCount()
      await expect(handlers.get('artifacts:addDropped')!({}, [path.join(loot, 'hashes.txt')], {}) as Promise<unknown>)
        .rejects.toThrow(config.ConfigInvalidError)
      expect(getEventCount()).toBe(count)
      expect(fs.existsSync(path.join(dir, 'artifacts'))).toBe(false)
    } finally { fs.rmSync(loot, { recursive: true, force: true }) }
  })
})
