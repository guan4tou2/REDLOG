import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildRemovalSteps, caUntrustCommand } from '../src/core/hooks-manager'
import { readProfilePath } from '../src/core/powershell-policy'

const CA = { path: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem', sha1: 'AABBCCDDEEFF00112233445566778899AABBCCDD' }

describe('mitmproxy removal steps', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux']
  for (const platform of platforms) {
    describe(platform, () => {
      let restore: () => void
      beforeEach(() => {
        const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { value: platform, configurable: true })
        restore = () => Object.defineProperty(process, 'platform', desc)
      })
      afterEach(() => restore())

      it('never kills by the 8080 port and never wipes ~/.mitmproxy', () => {
        const text = JSON.stringify(buildRemovalSteps('mitmproxy', CA))
        expect(text).not.toContain(':8080')
        expect(text).not.toMatch(/taskkill|netstat/)
        expect(text).not.toMatch(/rm -rf ~\/\.mitmproxy|rmdir \/s \/q/)
      })

      it('removes the CA by fingerprint, not by the name mitmproxy', () => {
        const ca = buildRemovalSteps('mitmproxy', CA)!.find((s) => /CA/.test(s.label))!
        expect(ca.command).toBe(caUntrustCommand(CA, platform))
        if (platform === 'win32') expect(ca.command).toBe(`certutil -delstore -user Root ${CA.sha1}`)
        if (platform === 'darwin') {
          expect(ca.command).toContain(`delete-certificate -Z ${CA.sha1}`)
          expect(ca.command).not.toMatch(/-c mitmproxy/)
        }
        if (platform === 'linux') {
          expect(ca.command).toContain('redlog-mitmproxy-aabbccddeeff0011.crt')
          expect(ca.command).not.toContain('/mitmproxy.crt')
        }
      })

      it('offers no CA command when the CA was never generated', () => {
        const ca = buildRemovalSteps('mitmproxy', null)!.find((s) => /CA/.test(s.label))!
        expect(ca.command).toBeUndefined()
      })
    })
  }
})

describe('readProfilePath', () => {
  it('is null off Windows and for unknown shells', () => {
    expect(readProfilePath('powershell', { platform: 'linux' })).toBeNull()
    expect(readProfilePath('cmd', { platform: 'win32' })).toBeNull()
  })
})

describe('PowerShell profile follows the redirected Documents folder', () => {
  let home: string
  let redirected: string
  let probe: ReturnType<typeof vi.fn>
  let hooks: typeof import('../src/core/hooks-manager')
  let restoreAll: () => void
  const legacy = (): string => path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-psredir-'))
    redirected = path.join(home, 'OneDrive', 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    const prev = { u: process.env.USERPROFILE, h: process.env.HOME }
    process.env.USERPROFILE = home
    process.env.HOME = home
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restoreAll = () => {
      Object.defineProperty(process, 'platform', desc)
      process.env.USERPROFILE = prev.u
      process.env.HOME = prev.h
    }
    probe = vi.fn((shell: string) => (shell === 'powershell' ? redirected : null))
    vi.resetModules()
    vi.doMock('../src/core/powershell-policy', async (orig) => ({
      ...(await orig<typeof import('../src/core/powershell-policy')>()),
      readProfilePath: probe
    }))
    hooks = await import('../src/core/hooks-manager')
  })
  afterEach(() => {
    restoreAll()
    vi.doUnmock('../src/core/powershell-policy')
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('installs into, and detects from, the redirected profile', () => {
    expect(hooks.installHook('shell-powershell').success).toBe(true)
    expect(fs.readFileSync(redirected, 'utf-8')).toMatch(/shell-hook\.ps1/)
    expect(fs.existsSync(legacy())).toBe(false)
    expect(hooks.detectHooks().find((h) => h.id === 'shell-powershell')!.installed).toBe(true)
  })

  it('falls back to the conventional path when the probe fails', () => {
    probe.mockReturnValue(null)
    vi.resetModules()
    return import('../src/core/hooks-manager').then((h) => {
      expect(h.installHook('shell-powershell').success).toBe(true)
      expect(fs.readFileSync(legacy(), 'utf-8')).toMatch(/shell-hook\.ps1/)
      expect(fs.existsSync(redirected)).toBe(false)
    })
  })

  it('removal cleans both the resolved and the legacy location', () => {
    const line = '. "$HOME\\.redlog\\shell-hook.ps1"'
    for (const p of [redirected, legacy()]) {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, `Set-Alias ll Get-ChildItem\r\n# RedLog PowerShell hook\r\n${line}\r\n`)
    }
    expect(hooks.uninstallHook('shell-powershell').success).toBe(true)
    for (const p of [redirected, legacy()]) {
      const text = fs.readFileSync(p, 'utf-8')
      expect(text).toContain('Set-Alias ll')
      expect(text).not.toMatch(/shell-hook\.ps1/)
    }
  })

  it('--remove-hooks path detects a hook that exists only at the legacy location', () => {
    fs.mkdirSync(path.dirname(legacy()), { recursive: true })
    fs.writeFileSync(legacy(), '# RedLog PowerShell hook\r\n. "$HOME\\.redlog\\shell-hook.ps1"\r\n')
    expect(hooks.removeInstalledHooks()).toContain('shell-powershell')
    expect(fs.existsSync(legacy())).toBe(false)
  })
})

describe('WSL rc removal', () => {
  const hookFile = "C:\\Program Files\\Red'Log\\hooks\\shell-bash-hook.sh"
  const step = (): { label: string; command?: string } => buildRemovalSteps('shell-wsl', null, hookFile)!.find((s) => /rc/.test(s.label))!

  it('names the exact lines and no longer deletes every line mentioning redlog', () => {
    const cmd = step().command!
    expect(cmd).not.toContain('/redlog/d')
    expect(cmd).not.toContain('sed')
    expect(cmd).toContain("source \"/mnt/c/Program Files/Red'\\''Log/hooks/shell-bash-hook.sh\"")
    expect(cmd).toContain('# RedLog WSL hook')
  })

  it('offers no command when the hook path is unknown', () => {
    expect(buildRemovalSteps('shell-wsl', null)!.find((s) => /rc/.test(s.label))!.command).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('run against a real rc, it removes only RedLog\'s lines', async () => {
    const { spawnSync } = await import('child_process')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-wslrc-'))
    try {
      const mine = "source \"/mnt/c/Program Files/Red'Log/hooks/shell-bash-hook.sh\""
      const keep = ['alias redlog-notes="cat ~/redlog.txt"', 'export PATH="$PATH:$HOME/redlog/bin"', '# redlog is my own project', 'source "/mnt/d/other/shell-bash-hook.sh"']
      fs.writeFileSync(path.join(home, '.bashrc'), [keep[0], '', '# RedLog WSL hook', mine, keep[1], keep[2], keep[3], ''].join('\n'))
      const r = spawnSync('sh', ['-c', step().command!], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe([keep[0], '', keep[1], keep[2], keep[3], ''].join('\n'))
      expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
      expect(fs.readdirSync(home).sort()).toEqual(['.bashrc'])
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})
