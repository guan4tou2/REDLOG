import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// #499: removing a `claude-settings` hook used to drop every PostToolUse hook
// whose command CONTAINED a string the plugin chose (`claudeSettingsMatcher`).
// A matcher of `.` or `.sh` is a substring of every operator hook there is, so
// uninstalling a plugin could silently strip the operator's own. Removal now
// matches the exact command RedLog wrote, and only that hook, not its group.

describe('claude-settings uninstall removes only the hook RedLog installed (#499)', () => {
  let home: string
  let pluginDir: string
  let restoreEnv: () => void
  let hooks: typeof import('../src/core/hooks-manager')
  let settingsPath: string
  const OWN = { command: '/home/op/bin/audit.sh --strict' }

  const readPostTool = (): Array<{ matcher?: string; hooks: Array<{ command: string }> }> =>
    JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks.PostToolUse

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-claude-settings-'))
    pluginDir = path.join(home, 'plugin')
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'acme-hook.sh'), '#!/bin/sh\n')
    settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const prev = { h: process.env.HOME, u: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    restoreEnv = () => {
      if (prev.h === undefined) delete process.env.HOME; else process.env.HOME = prev.h
      if (prev.u === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.u
    }
    vi.resetModules()
    hooks = await import('../src/core/hooks-manager')
    // The matcher is the hostile part: it matches every command. It is no
    // longer a manifest field at all, so it is passed through untyped.
    const entry = {
      id: 'cc', name: 'Acme', description: 'd', agentType: 'agent', hookFile: 'acme-hook.sh',
      installMethod: 'claude-settings', claudeSettingsMatcher: '.'
    } as unknown as Parameters<typeof hooks.registerCapturePlugins>[2][number]
    expect(hooks.registerCapturePlugins('acme', pluginDir, [entry]).accepted).toBe(1)
  })
  afterEach(() => { restoreEnv(); fs.rmSync(home, { recursive: true, force: true }) })

  it('keeps the operator\'s own hooks, whatever string the plugin names', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [OWN] }] } }))

    expect(hooks.installHook('acme.cc').success).toBe(true)
    expect(readPostTool()).toHaveLength(2)

    expect(hooks.uninstallHook('acme.cc').success).toBe(true)
    expect(readPostTool()).toEqual([{ matcher: 'Bash', hooks: [OWN] }])
  })

  it('removes its own hook from a group the operator shares, and keeps theirs', () => {
    const ours = path.join(pluginDir, 'acme-hook.sh')
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [OWN, { command: ours }] }] } }))

    expect(hooks.uninstallHook('acme.cc').success).toBe(true)
    expect(readPostTool()).toEqual([{ matcher: 'Bash', hooks: [OWN] }])
  })

  it('does not take another file in the plugin folder for its own hook', () => {
    const lookalike = { command: `${path.join(pluginDir, 'acme-hook.sh')}.bak` }
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [lookalike] }] } }))
    expect(hooks.uninstallHook('acme.cc').success).toBe(true)
    expect(readPostTool()).toEqual([{ matcher: 'Bash', hooks: [lookalike] }])
  })
})
