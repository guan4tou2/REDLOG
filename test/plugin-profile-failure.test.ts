import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// #499. A revoked or never-approved profile must not stay in effect because
// something else went wrong. The shell reads ~/.redlog/terminal-profiles.json
// and cannot ask the app, so whatever is in that file is what a new terminal
// does. These go through the real loader against a temp home: a plugin that
// throws while it applies, a plugin whose manifest is the wrong shape, a
// snapshot an older build left behind, and a snapshot that cannot be replaced.

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

// One registrar made to throw for one plugin id, so a plugin can fail while it
// applies without its manifest being invalid.
vi.mock('../src/core/command-tagger', async (orig) => {
  const real = await orig<typeof import('../src/core/command-tagger')>()
  return {
    ...real,
    registerCommandTags: (id: string, tags: Parameters<typeof real.registerCommandTags>[1]) => {
      if (id === 'aaa-boom') throw new Error('kaboom')
      return real.registerCommandTags(id, tags)
    }
  }
})

// Taking a plugin's contributions back can fail too; this makes one kind of it
// throw, for prof-a, when a test says so.
const brk = vi.hoisted(() => ({ unregister: false }))
vi.mock('../src/core/loot-detector', async (orig) => {
  const real = await orig<typeof import('../src/core/loot-detector')>()
  return {
    ...real,
    unregisterLootPatterns: (id: string) => {
      if (brk.unregister && id === 'prof-a') throw new Error('unregister broke')
      return real.unregisterLootPatterns(id)
    }
  }
})

import {
  initPlugins, listPlugins, grantPluginTrust, revokePluginTrust, reloadPlugins, setPluginEnabled
} from '../src/core/plugins'
import { removeContributions, getContributionReport } from '../src/core/plugins/contributions'
import { revoke } from '../src/core/plugins/trust'

let tmp: string
let realHome: string | undefined
let realProfile: string | undefined
const IDS = ['aaa-boom', 'bad-one', 'prof-a', 'zzz-prof', 'old-one', 'new-one']

const tool = (exe: string): Record<string, unknown> =>
  ({ id: 'tool', name: 'Tool', mode: 'pty', executables: [exe], reason: 'brings its own PTY' })

const writePlugin = (id: string, contributes: unknown): void => {
  const dir = path.join(tmp, '.redlog', 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', redlogApi: 1, contributes
  }))
}
const snapshotFile = (): string => path.join(tmp, '.redlog', 'terminal-profiles.json')
const snapshotIds = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(), 'utf8')).profiles.map((p: { id: string }) => p.id)
  } catch { return [] }
}
const view = (id: string) => listPlugins().find((p) => p.manifest.id === id)

beforeEach(() => {
  realHome = process.env.HOME
  realProfile = process.env.USERPROFILE
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pfail-'))
  process.env.HOME = tmp
  process.env.USERPROFILE = tmp
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const id of IDS) { removeContributions(id); revoke(id) }
  process.env.HOME = realHome
  process.env.USERPROFILE = realProfile
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a broken plugin does not keep a revoked profile alive', () => {
  // The reviewer's repro. `capture` as a string passed validation, then threw
  // `c.capture.map is not a function` out of applyAll, so initPlugins never
  // reached the write and the snapshot kept what the revoke was meant to take.
  it('a plugin whose contributes is the wrong shape is an error plugin, and a revoke still takes effect', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    expect(grantPluginTrust('prof-a')).toMatchObject({ ok: true })
    expect(snapshotIds()).toEqual(['prof-a/tool'])

    writePlugin('bad-one', { capture: 'abc' })
    expect(() => revokePluginTrust('prof-a')).not.toThrow()
    expect(snapshotIds()).toEqual([])
    expect(fs.existsSync(snapshotFile())).toBe(false)
    expect(view('bad-one')?.status).toBe('error')
    expect(view('bad-one')?.error).toMatch(/capture/)

    expect(() => initPlugins()).not.toThrow()
    expect(fs.existsSync(snapshotFile())).toBe(false)
  })

  it('a plugin that throws while it applies becomes an error plugin; the others still load and the snapshot is written', () => {
    writePlugin('aaa-boom', { commandTags: [{ name: 't', match: 'x', stamp: { a: 'b' } }] })
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    writePlugin('zzz-prof', { terminalProfiles: [tool('zzz-bin')] })
    initPlugins()
    expect(grantPluginTrust('prof-a')).toMatchObject({ ok: true })
    expect(grantPluginTrust('zzz-prof')).toMatchObject({ ok: true })

    expect(view('aaa-boom')?.status).toBe('error')
    expect(view('aaa-boom')?.error).toMatch(/kaboom/)
    expect(snapshotIds()).toEqual(['prof-a/tool', 'zzz-prof/tool'])

    // and a revoke, with the throwing plugin still there, takes only that one
    revokePluginTrust('prof-a')
    expect(snapshotIds()).toEqual(['zzz-prof/tool'])
  })

  // If the scan itself throws nothing is approved as far as this run knows, and
  // the snapshot says so: it is written from what is registered, not skipped.
  // The error is still the caller's to see.
  it('when the scan itself throws the snapshot is still rewritten, from nothing, and the error is not hidden', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    grantPluginTrust('prof-a')
    expect(snapshotIds()).toEqual(['prof-a/tool'])

    // The plugins folder becomes a file: listing it throws ENOTDIR.
    const root = path.join(tmp, '.redlog', 'plugins')
    fs.renameSync(root, `${root}-away`)
    fs.writeFileSync(root, 'not a folder')
    expect(() => initPlugins()).toThrow(/ENOTDIR/)
    expect(fs.existsSync(snapshotFile())).toBe(false)
  })

  it('when taking a revoked plugin\'s contributions back fails part way, its profiles are still taken back', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    grantPluginTrust('prof-a')
    expect(snapshotIds()).toEqual(['prof-a/tool'])
    brk.unregister = true
    try {
      expect(() => revokePluginTrust('prof-a')).not.toThrow()
    } finally { brk.unregister = false }
    expect(fs.existsSync(snapshotFile())).toBe(false)
  })

  it('what an erroring plugin had already registered is taken back', () => {
    writePlugin('aaa-boom', {
      lootPatterns: [{ type: 'boom-secret', pattern: 'BOOMSECRET[0-9]+' }],
      commandTags: [{ name: 't', match: 'x', stamp: { a: 'b' } }]
    })
    initPlugins()
    expect(view('aaa-boom')?.status).toBe('error')
    expect(getContributionReport('aaa-boom')).toBeUndefined()
  })
})

describe('a snapshot from before this check', () => {
  const oldSnapshot = {
    version: 1,
    profiles: [{ id: 'old-one/tool', name: 'Tool', mode: 'pty', executables: ['oldtool'], reason: 'r' }],
    held: { oldtool: 'old-one/tool' }
  }

  it('holding the profile of a plugin that was never approved: the next initPlugins removes it', () => {
    writePlugin('old-one', { terminalProfiles: [tool('oldtool')] })
    fs.mkdirSync(path.dirname(snapshotFile()), { recursive: true })
    fs.writeFileSync(snapshotFile(), JSON.stringify(oldSnapshot))
    initPlugins()
    expect(view('old-one')?.status).toBe('needs-consent')
    expect(fs.existsSync(snapshotFile())).toBe(false)
  })

  it('next to an approved plugin, only the approved one is written', () => {
    writePlugin('old-one', { terminalProfiles: [tool('oldtool')] })
    writePlugin('new-one', { terminalProfiles: [tool('newtool')] })
    initPlugins()
    grantPluginTrust('new-one')
    fs.writeFileSync(snapshotFile(), JSON.stringify({
      ...oldSnapshot, profiles: [...oldSnapshot.profiles, { id: 'new-one/tool', name: 'Tool', mode: 'pty', executables: ['newtool'], reason: 'r' }],
      held: { oldtool: 'old-one/tool', newtool: 'new-one/tool' }
    }))
    initPlugins()
    const written = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'))
    expect(written.profiles.map((p: { id: string }) => p.id)).toEqual(['new-one/tool'])
    expect(written.held.newtool).toBe('new-one/tool')
    expect(written.held).not.toHaveProperty('oldtool')
  })
})

describe('a snapshot that cannot be replaced is said so', () => {
  const busy = (code: string): Error => Object.assign(new Error(`${code}: the file is held`), { code })

  it('revoke: the summary says the old profiles may still apply, and the next successful write clears it', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    grantPluginTrust('prof-a')
    expect(snapshotIds()).toEqual(['prof-a/tool'])

    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw busy('EPERM') })
    const summary = revokePluginTrust('prof-a')
    expect(summary.profilesError).toMatch(/held/)
    expect(snapshotIds()).toEqual(['prof-a/tool'])

    vi.restoreAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(reloadPlugins().profilesError).toBeUndefined()
    expect(fs.existsSync(snapshotFile())).toBe(false)
  })

  it('disable: the same', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    grantPluginTrust('prof-a')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw busy('EBUSY') })
    expect(setPluginEnabled('prof-a', false).profilesError).toMatch(/held/)
  })

  it('grant: it succeeded, and says the shell may not have the new profiles yet', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy('EACCES') })
    const r = grantPluginTrust('prof-a')
    expect(r.ok).toBe(true)
    expect(r.profilesError).toMatch(/held/)
  })

  it('an ordinary reload has no error', () => {
    writePlugin('prof-a', { terminalProfiles: [tool('prof-a-bin')] })
    initPlugins()
    expect(grantPluginTrust('prof-a').profilesError).toBeUndefined()
    expect(reloadPlugins().profilesError).toBeUndefined()
  })
})
