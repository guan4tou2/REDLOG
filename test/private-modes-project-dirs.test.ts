import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restrictProjectDirs } from '../src/main/project-dir-modes'
import { saveHookConfig } from '../src/main/services/hook-config'
import { recordProxyOwner } from '../src/main/services/port-holder'

// Project subdirectories created with the default mode came out 0755 under a
// 022 umask (`casts`, `exports` in an audit of a real ~/.redlog). Opening the
// project tightens the known ones; it does not walk what is inside them.
const posixIt = it.skipIf(process.platform === 'win32')
const bits = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8)

let root: string
let savedUmask: number | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-projdirs-'))
  if (process.platform !== 'win32') savedUmask = process.umask(0o022)
})
afterEach(() => {
  if (savedUmask !== undefined) process.umask(savedUmask)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('restrictProjectDirs', () => {
  posixIt('makes existing project subdirectories 0700 and leaves the files in them alone', () => {
    for (const name of ['casts', 'exports', 'raw']) fs.mkdirSync(path.join(root, name), { mode: 0o755 })
    fs.writeFileSync(path.join(root, 'casts', 'a.cast'), '', { mode: 0o644 })
    fs.mkdirSync(path.join(root, 'exports', 'bundle-1'), { mode: 0o755 })
    restrictProjectDirs(root)
    expect(bits(path.join(root, 'casts'))).toBe('700')
    expect(bits(path.join(root, 'exports'))).toBe('700')
    expect(bits(path.join(root, 'raw'))).toBe('700')
    // Not a tree walk: contents keep their modes.
    expect(bits(path.join(root, 'casts', 'a.cast'))).toBe('644')
    expect(bits(path.join(root, 'exports', 'bundle-1'))).toBe('755')
  })

  posixIt('creates nothing that is missing', () => {
    restrictProjectDirs(root)
    expect(fs.readdirSync(root)).toEqual([])
  })

  posixIt('does not follow a symlinked subdirectory out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-outside-'))
    try {
      fs.chmodSync(outside, 0o755)
      fs.symlinkSync(outside, path.join(root, 'casts'))
      restrictProjectDirs(root)
      expect(bits(outside)).toBe('755')
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })

  posixIt('changes nothing on Windows', () => {
    fs.mkdirSync(path.join(root, 'casts'), { mode: 0o755 })
    restrictProjectDirs(root, 'win32')
    expect(bits(path.join(root, 'casts'))).toBe('755')
  })
})

describe('~/.redlog files written by main create their directory owner-only', () => {
  posixIt('hook-config.json', () => {
    saveHookConfig({ excludedPaths: [] }, path.join(root, '.redlog', 'hook-config.json'))
    expect(bits(path.join(root, '.redlog'))).toBe('700')
  })

  posixIt('managed-proxy-owner.json', async () => {
    await recordProxyOwner(path.join(root, '.redlog', 'managed-proxy-owner.json'),
      { pid: 1, host: '127.0.0.1', port: 8080, addonPath: '/x' }, async () => 'Mon Jan  1 00:00:00 2026')
    expect(bits(path.join(root, '.redlog'))).toBe('700')
  })
})
