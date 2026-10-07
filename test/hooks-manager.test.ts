import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import { detectHooks, getHookInstallPlan, installHook } from '../src/core/hooks-manager'
import { loadPlugins } from '../src/core/plugins/loader'
import { applyContributions } from '../src/core/plugins/contributions'

// process.platform is non-writable; test the Windows refusal branch by
// swapping it in-place then restoring.
function pretendPlatform(p: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  return () => Object.defineProperty(process, 'platform', original)
}

describe('hooks-manager guided setup', () => {
  const hooks = detectHooks()
  const byId = (id: string) => hooks.find((h) => h.id === id)!

  it('exposes every registered plugin with a resolved hookFile', () => {
    for (const h of hooks) {
      expect(h.hookFile.length).toBeGreaterThan(0)
    }
  })

  it('one-click hooks carry no manual steps', () => {
    // v0.7.3 A: `claude-code` retired from the registry — its per-tool
    // ingest is now handled by the agent tailer (`agent-tailer.ts`), which reads
    // Claude Code's own transcript file. No hook install needed anymore.
    for (const id of ['shell-zsh', 'shell-bash']) {
      expect(byId(id).installMethod).not.toBe('manual')
      expect(byId(id).manualSteps).toBeUndefined()
    }
  })

  it('installs each POSIX adapter beside the shared runtime it sources', () => {
    for (const id of ['shell-zsh', 'shell-bash']) {
      const plan = getHookInstallPlan(id)
      expect(plan?.map((file) => file.target.split(/[\\/]/).pop())).toEqual([
        id === 'shell-zsh' ? 'shell-hook.zsh' : 'shell-bash-hook.sh',
        'shell-common.sh', 'redlog-session.py', 'redlog-relay.py'
      ])
      expect(plan?.every((file) => fs.existsSync(file.source))).toBe(true)
    }
  })

  it('mitmproxy is guided-manual with a runnable mitmdump command', () => {
    const m = byId('mitmproxy')
    expect(m.installMethod).toBe('manual')
    expect(m.manualSteps?.length).toBeGreaterThan(0)
    // Under one branch the first step is the runnable mitmdump command;
    // under the "binary not on PATH" branch (commit 1645578) it's prefixed
    // by an install-guidance step and the mitmdump command appears later.
    // Assert on the presence of the runnable command anywhere in the list.
    const mitmdumpStep = m.manualSteps!.find((s) => s.command?.includes('mitmdump -s'))
    expect(mitmdumpStep).toBeDefined()
    const cmd = mitmdumpStep!.command!
    // the absolute addon path is baked into the copy-paste command
    expect(cmd).toContain(m.hookFile)
    expect(cmd).toContain('mitmproxy-addon.py')
  })

  // Every step on this card runs `mitmdump`, so on a machine without it they
  // are all "command not found" — the usual case on Windows, where nothing
  // brings mitmproxy in. The card used to open on step 1 of a sequence whose
  // unstated step 0 was an install.
  it('names the missing dependency before the commands that need it', () => {
    const m = byId('mitmproxy')
    const steps = m.manualSteps!
    if (m.available) {
      // Present: an install step would be noise on every machine that has it.
      expect(steps.some((s) => s.command?.includes('uv tool install'))).toBe(false)
    } else {
      expect(steps[0].command).toBe('uv tool install mitmproxy')
      // And where RedLog will do it for them, not only how to do it by hand.
      expect(steps[0].label).toMatch(/capture check|dashboard/i)
      // Before the commands that cannot work without it.
      expect(steps.findIndex((s) => s.command?.includes('mitmdump -s'))).toBeGreaterThan(0)
    }
  })

  // Codex is contributed by pack-ai-agents now, not shipped as a built-in, so
  // it reaches detectHooks only once that pack's contributions are applied —
  // and under the namespaced id every contributed producer gets. Its setup
  // steps still come from code rather than the manifest, because they branch
  // on the platform and a manifest's `manualSteps` are one fixed list.
  it('codex is guided-manual with platform-appropriate steps', () => {
    const pack = loadPlugins().find((p) => p.manifest.id === 'pack-ai-agents')
    expect(pack, 'pack-ai-agents not found on disk').toBeDefined()
    applyContributions(pack!)
    const c = detectHooks().find((h) => h.id === 'pack-ai-agents.codex')!
    expect(c, 'the pack contributes no codex producer').toBeDefined()
    expect(c.installMethod).toBe('manual')
    expect(c.manualSteps?.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      // Windows: a note, not a broken bash command
      expect(c.manualSteps?.every((s) => !s.command)).toBe(true)
      expect(c.manualSteps?.[0].label).toMatch(/WSL|Git Bash/)
    } else {
      expect(c.manualSteps?.some((s) => s.command?.includes(c.hookFile))).toBe(true)
      expect(c.manualSteps?.some((s) => s.command?.includes('codex run'))).toBe(true)
    }
  })
})

describe('installHook Windows refusal (Audit P0-3)', () => {
  let restore: (() => void) | null = null
  afterEach(() => { restore?.(); restore = null })

  it('shell-source install returns success:false on win32', () => {
    restore = pretendPlatform('win32')
    // `shell-zsh` is a real registered plugin with installMethod:
    // 'shell-source'. On Windows the branch must refuse rather than
    // fabricate a %USERPROFILE%\.zshrc.
    const r = installHook('shell-zsh')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/windows|powershell|\$profile/i)
    // Message should point at the setup doc so operators know what to do.
    expect(r.message).toMatch(/docs\/windows-setup\.md|\$PROFILE/)
  })

  it('shell-source refusal still returns a stable object shape', () => {
    restore = pretendPlatform('win32')
    const r = installHook('shell-bash')
    // Both fields present, no throw, no fs write.
    expect(typeof r.success).toBe('boolean')
    expect(typeof r.message).toBe('string')
    expect(r.success).toBe(false)
  })

  it('unknown plugin id fails identically on every platform', () => {
    restore = pretendPlatform('win32')
    const r = installHook('nonexistent-plugin')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/unknown/i)
  })
})
