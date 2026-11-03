import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { LoadedPlugin, PluginStatus } from '../src/core/plugins/types'

// #499. Who may contribute terminal profiles. A profile changes what the shell
// does to a command typed by the operator, so a plugin that is not in a state
// to contribute does not: error and disabled are skipped by `applyAll`, and a
// plugin still waiting for the operator's approval of its current hash is held
// back by the contribution itself. The statuses are set here by hand and run
// through the real `initPlugins`, because the loader is the one thing that
// decides them and the gate is what reads them.

const m = vi.hoisted(() => ({ plugins: [] as unknown[] }))
vi.mock('../src/core/plugins/loader', () => ({ loadPlugins: () => m.plugins }))

import { initPlugins } from '../src/core/plugins'
import { getContributionReport, removeContributions } from '../src/core/plugins/contributions'

let tmp: string
let realHome: string | undefined
let realProfile: string | undefined
const IDS = ['gate-error', 'gate-disabled', 'gate-consent', 'gate-changed', 'gate-active']

const profile = (exe: string): Record<string, unknown> =>
  ({ id: 'tool', name: 'Tool', mode: 'pty', executables: [exe], reason: 'r' })

const plugin = (id: string, status: PluginStatus, over: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  manifest: {
    id, name: id, version: '1.0.0', redlogApi: 1,
    contributes: { terminalProfiles: [profile(`${id}-bin`)] }
  } as LoadedPlugin['manifest'],
  dir: '/nowhere', source: 'user', tier: 'declarative', status, contentHash: 'x', ...over
})

const written = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmp, '.redlog', 'terminal-profiles.json'), 'utf8'))
      .profiles.map((p: { id: string }) => p.id)
  } catch { return [] }
}

beforeEach(() => {
  realHome = process.env.HOME
  realProfile = process.env.USERPROFILE
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-gate-'))
  process.env.HOME = tmp
  process.env.USERPROFILE = tmp
})
afterEach(() => {
  m.plugins = []
  for (const id of IDS) removeContributions(id)
  process.env.HOME = realHome
  process.env.USERPROFILE = realProfile
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('which plugins contribute terminal profiles', () => {
  it('only one in a state to contribute: error, disabled and awaiting approval contribute nothing', () => {
    m.plugins = [
      plugin('gate-error', 'error'),
      plugin('gate-disabled', 'disabled'),
      plugin('gate-consent', 'needs-consent', { tier: 'privileged' }),
      plugin('gate-changed', 'hash-changed', { tier: 'privileged' }),
      plugin('gate-active', 'active')
    ]
    initPlugins()
    expect(written()).toEqual(['gate-active/tool'])
  })

  it('an error plugin alone writes no file', () => {
    m.plugins = [plugin('gate-error', 'error')]
    initPlugins()
    expect(written()).toEqual([])
  })

  it('a plugin awaiting approval says why in its report, and registers nothing', () => {
    m.plugins = [plugin('gate-consent', 'needs-consent', { tier: 'privileged' })]
    initPlugins()
    expect(getContributionReport('gate-consent')?.terminalProfiles).toEqual({ accepted: 0, rejected: [], waiting: true })
    expect(written()).toEqual([])
  })

  it('an approved plugin is reported by what was accepted, with no waiting flag', () => {
    m.plugins = [plugin('gate-active', 'active')]
    initPlugins()
    expect(getContributionReport('gate-active')?.terminalProfiles).toEqual({ accepted: 1, rejected: [] })
  })

  it('profiles appear when the plugin becomes approved, and go when it stops being', () => {
    m.plugins = [plugin('gate-consent', 'needs-consent', { tier: 'privileged' })]
    initPlugins()
    expect(written()).toEqual([])
    m.plugins = [plugin('gate-consent', 'active', { tier: 'privileged' })]
    initPlugins()
    expect(written()).toEqual(['gate-consent/tool'])
    m.plugins = [plugin('gate-consent', 'hash-changed', { tier: 'privileged' })]
    initPlugins()
    expect(written()).toEqual([])
  })
})
