import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// "Hook removed" has to be true of the terminals the operator can see. The rc
// edit only reaches new shells, so the message says what happens to the ones
// that are already open: zsh terminals are stopped by RedLog, bash has no
// per-terminal state to stop and says so.

describe.skipIf(process.platform === 'win32')('shell hook uninstall message', () => {
  let home: string
  let restoreEnv: () => void
  let hooks: typeof import('../src/core/hooks-manager')
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-uninstall-msg-'))
    const prev = { h: process.env.HOME, u: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    restoreEnv = () => { process.env.HOME = prev.h; process.env.USERPROFILE = prev.u }
    vi.resetModules()
    hooks = await import('../src/core/hooks-manager')
  })
  afterEach(() => { restoreEnv(); fs.rmSync(home, { recursive: true, force: true }) })

  it('tells a bash operator that open terminals keep recording', () => {
    expect(hooks.installHook('shell-bash').success).toBe(true)
    const r = hooks.uninstallHook('shell-bash')
    expect(r.success).toBe(true)
    expect(r.message).toContain('New terminals will not record.')
    expect(r.message).toContain('already open keep recording until you close them')
  })

  it('does not make that claim for zsh, whose open terminals are stopped', () => {
    expect(hooks.installHook('shell-zsh').success).toBe(true)
    const r = hooks.uninstallHook('shell-zsh')
    expect(r.success).toBe(true)
    expect(r.message).toContain('New terminals will not record.')
    expect(r.message).not.toContain('keep recording')
  })
})
