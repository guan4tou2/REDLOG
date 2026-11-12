import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// project:create / project:delete as a probe found them: a 10 000-character
// name stored as is (rename cuts at 120), a caller's `engagement.id` kept over
// the generated one so two projects shared an id, the open project deleted out
// from under the API, and config.yaml / cast-index.db left 0644.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pm-guard-'))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome }
})

const pm = await import('../src/core/project-manager')
const { loadConfig, saveConfig, mergeInitialConfig } = await import('../src/core/config')

describe('project names', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmpHome, '.redlog'), { recursive: true, force: true })
  })
  afterAll(() => { fs.rmSync(tmpHome, { recursive: true, force: true }) })

  it('create applies the rename limit and trimming', () => {
    const p = pm.createProject(`  ${'n'.repeat(10_000)}  `)
    expect(p.name).toBe('n'.repeat(120))
    expect(pm.listProjectEntries()[0].name).toBe('n'.repeat(120))
    const renamed = pm.renameProject(p.id, 'r'.repeat(10_000))
    expect(renamed?.name.length).toBe(p.name.length)
  })

  it('create refuses a name that is empty once trimmed', () => {
    expect(() => pm.createProject('   ')).toThrow()
    expect(pm.listProjectEntries()).toEqual([])
  })

  it('delete refuses the open project and leaves it on disk and listed', () => {
    const open = pm.createProject('Open one')
    const closed = pm.createProject('Closed one')
    expect(pm.deleteProject(open.id, open.id)).toBe(false)
    expect(fs.existsSync(open.path)).toBe(true)
    expect(pm.listProjectEntries().map((p) => p.id)).toContain(open.id)
    // Another project is still deletable while one is open.
    expect(pm.deleteProject(closed.id, open.id)).toBe(true)
    expect(fs.existsSync(closed.path)).toBe(false)
  })
})

describe('a new project config', () => {
  it('always carries the generated engagement id, whatever the caller sends', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-id-'))
    try {
      const merged = mergeInitialConfig(loadConfig(dir), 'proj-new', {
        engagement: { id: 'someone-elses-project', activeTarget: '10.0.0.5' }
      } as never)
      expect(merged.engagement.id).toBe('proj-new')
      expect(merged.engagement.activeTarget).toBe('10.0.0.5')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe.skipIf(process.platform === 'win32')('owner-only project files', () => {
  it('config.yaml is written 0600, including over an older 0644 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cfg-mode-'))
    try {
      saveConfig(dir, loadConfig(dir))
      expect(fs.statSync(path.join(dir, 'config.yaml')).mode & 0o777).toBe(0o600)
      fs.chmodSync(path.join(dir, 'config.yaml'), 0o644)
      saveConfig(dir, loadConfig(dir))
      expect(fs.statSync(path.join(dir, 'config.yaml')).mode & 0o777).toBe(0o600)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('cast-index.db is created 0600', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-castidx-mode-'))
    let castIndex: typeof import('../src/core/cast-index') | null = null
    try {
      castIndex = await import('../src/core/cast-index')
      castIndex.getCastIndex(dir)
      expect(fs.statSync(path.join(dir, 'cast-index.db')).mode & 0o777).toBe(0o600)
    } finally {
      castIndex?.closeCastIndex()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
