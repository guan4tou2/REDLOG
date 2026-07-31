import { describe, it, expect } from 'vitest'
import { detectHooks, isBrokenShellHook } from '../src/core/hooks-manager'

describe('hooks-manager guided setup', () => {
  const hooks = detectHooks()
  const byId = (id: string) => hooks.find((h) => h.id === id)!

  it('exposes every registered plugin with a resolved hookFile', () => {
    for (const h of hooks) {
      expect(h.hookFile.length).toBeGreaterThan(0)
    }
  })

  it('one-click hooks carry no manual steps', () => {
    for (const id of ['claude-code', 'shell-zsh', 'shell-bash']) {
      expect(byId(id).installMethod).not.toBe('manual')
      expect(byId(id).manualSteps).toBeUndefined()
    }
  })

  it('mitmproxy is guided-manual with a runnable mitmdump command', () => {
    const m = byId('mitmproxy')
    expect(m.installMethod).toBe('manual')
    expect(m.manualSteps?.length).toBeGreaterThan(0)
    const cmd = m.manualSteps![0].command!
    expect(cmd).toContain('mitmdump -s')
    // the absolute addon path is baked into the copy-paste command
    expect(cmd).toContain(m.hookFile)
    expect(cmd).toContain('mitmproxy-addon.py')
  })

  it('recognises the pre-v0.6.47 $$$ pid marker as broken', () => {
    // Both quote styles appeared in the wild — python & POSIX both wrote it.
    expect(isBrokenShellHook("payload='{\"pid\": $$$}'")).toBe(true)
    expect(isBrokenShellHook("payload=\"{'pid': $$$}\"")).toBe(true)
  })

  it('does not flag a hook that has $$ (correct PID substitution)', () => {
    expect(isBrokenShellHook("payload='{\"pid\": $$}'")).toBe(false)
    expect(isBrokenShellHook('#!/bin/bash\nset -e\n')).toBe(false)
  })

  it('codex is guided-manual with platform-appropriate steps', () => {
    const c = byId('codex')
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
