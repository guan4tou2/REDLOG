import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// An enrolled shell sources its hook from ~/.redlog, a copy written once at
// install. An upgrade left that copy alone, so a hook fix reached only people
// who enrolled after upgrading — and Settings still said "installed". Found in
// the 2026-10-28 Windows acceptance: the PowerShell pairing fix was in the new
// app and not in the shell. The app now brings an enrolled copy up to date.

const HOOKS = path.resolve(__dirname, '..', 'hooks')
const bundled = (name: string): string => fs.readFileSync(path.join(HOOKS, name), 'utf8')

let home: string
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

async function load(): Promise<typeof import('../src/core/hooks-manager')> {
  vi.resetModules()
  return import('../src/core/hooks-manager')
}
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
  fs.writeFileSync(path.join(home, rel), text)
}
const read = (rel: string): string => fs.readFileSync(path.join(home, rel), 'utf8')
const enrollPowerShell = (): void => write('Documents/PowerShell/Microsoft.PowerShell_profile.ps1', '# RedLog PowerShell hook\r\n. "$HOME\\.redlog\\shell-hook.ps1"\r\n')

describe('an enrolled hook copy follows the app', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hookrefresh-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })
  afterEach(() => {
    process.env.HOME = saved.HOME
    process.env.USERPROFILE = saved.USERPROFILE
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rewrites an enrolled PowerShell hook that differs from the bundled one', async () => {
    enrollPowerShell()
    write('.redlog/shell-hook.ps1', '# hook from the previous release\r\n')
    const { refreshInstalledHooks } = await load()
    expect(refreshInstalledHooks()).toEqual(['shell-powershell'])
    expect(read('.redlog/shell-hook.ps1')).toBe(bundled('shell-hook.ps1'))
  })

  it('rewrites an enrolled bash hook and every file it sources', async () => {
    write('.bashrc', 'source ~/.redlog/shell-bash-hook.sh\n')
    write('.redlog/shell-bash-hook.sh', '# old adapter\n')
    write('.redlog/shell-common.sh', '# old runtime\n')
    const { refreshInstalledHooks, getHookInstallPlan } = await load()
    expect(refreshInstalledHooks()).toContain('shell-bash')
    for (const file of getHookInstallPlan('shell-bash')!) {
      expect(fs.readFileSync(file.target, 'utf8')).toBe(fs.readFileSync(file.source, 'utf8'))
    }
  })

  it('leaves alone a copy that no shell sources, and enrolls nothing', async () => {
    write('.redlog/shell-hook.ps1', '# left behind, not in any profile\r\n')
    const { refreshInstalledHooks } = await load()
    expect(refreshInstalledHooks()).toEqual([])
    expect(read('.redlog/shell-hook.ps1')).toBe('# left behind, not in any profile\r\n')
    expect(fs.existsSync(path.join(home, '.redlog', 'shell-hook.zsh'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.redlog', 'shell-bash-hook.sh'))).toBe(false)
  })

  it('does not rewrite a copy that is already current', async () => {
    enrollPowerShell()
    write('.redlog/shell-hook.ps1', bundled('shell-hook.ps1'))
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(path.join(home, '.redlog', 'shell-hook.ps1'), old, old)
    const { refreshInstalledHooks } = await load()
    expect(refreshInstalledHooks()).toEqual([])
    expect(fs.statSync(path.join(home, '.redlog', 'shell-hook.ps1')).mtimeMs).toBe(old.getTime())
  })
})
