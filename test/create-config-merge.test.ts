import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig, mergeInitialConfig } from '../src/core/config'

// Spec 037: the create card sends scope, excludes and — when the operator
// ticks "ignore this machine's own traffic" — its IP as a personal domain, in
// the one project:create call. The merge used to be a shallow spread, so a
// personalDomains array replaced the defaults (loopback, localhost) and the
// picker had to patch the config with a second save after creation.

describe('mergeInitialConfig', () => {
  const base = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-create-merge-'))
    try { return loadConfig(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('adds personal domains to the defaults instead of replacing them', () => {
    const cfg = base()
    const merged = mergeInitialConfig(cfg, 'proj-1', { scope: { personalDomains: ['192.168.1.23'] } } as never)
    expect(merged.scope.personalDomains).toEqual([...(cfg.scope.personalDomains ?? []), '192.168.1.23'])
    expect(merged.scope.personalDomains).toContain('127.0.0.0/8')
  })

  it('does not add a personal domain twice', () => {
    const cfg = base()
    const merged = mergeInitialConfig(cfg, 'proj-1', { scope: { personalDomains: ['localhost'] } } as never)
    expect(merged.scope.personalDomains?.filter((d) => d === 'localhost')).toHaveLength(1)
  })

  it('keeps scope fields it was not given, and seeds the engagement id from the project', () => {
    const cfg = base()
    const merged = mergeInitialConfig(cfg, 'proj-1', { scope: { targets: ['10.10.11.0/24'] } } as never)
    expect(merged.scope.targets).toEqual(['10.10.11.0/24'])
    expect(merged.scope.personalDomains).toEqual(cfg.scope.personalDomains)
    expect(merged.engagement.id).toBe('proj-1')
  })
})
