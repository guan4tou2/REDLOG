import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensurePtyHelperExecutable } from '../src/core/pty-helper'

// A shell that cannot be started fails as `posix_spawnp failed` and records
// nothing. The helper's execute bit is checked where the terminal starts.

// These build fixtures with chmod. Windows keeps no POSIX mode bits, so chmod
// cannot make a file "not executable" there and the premise does not hold; the
// helper itself is only ever touched on macOS.
const posixOnly = it.skipIf(process.platform === 'win32')

describe('node-pty spawn-helper permission', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pty-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const helper = (rel: string, mode: number): string => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, mode)
    return file
  }
  const exec = (file: string): boolean => (fs.statSync(file).mode & 0o111) !== 0

  posixOnly('restores the execute bit that an install left off', () => {
    const arm = helper('prebuilds/darwin-arm64/spawn-helper', 0o644)
    const x64 = helper('prebuilds/darwin-x64/spawn-helper', 0o644)
    const result = ensurePtyHelperExecutable(root, 'darwin')
    expect(result.fixed.sort()).toEqual([arm, x64].sort())
    expect(result.failed).toEqual([])
    expect(exec(arm) && exec(x64)).toBe(true)
  })

  posixOnly('leaves a helper that already runs alone, and a build that does not ship one', () => {
    const ok = helper('build/Release/spawn-helper', 0o755)
    const before = fs.statSync(ok).mode
    expect(ensurePtyHelperExecutable(root, 'darwin')).toEqual({ fixed: [], failed: [] })
    expect(fs.statSync(ok).mode).toBe(before)
  })

  it('does nothing off macOS, where node-pty has no such helper', () => {
    const file = helper('prebuilds/darwin-arm64/spawn-helper', 0o644)
    expect(ensurePtyHelperExecutable(root, 'linux')).toEqual({ fixed: [], failed: [] })
    expect(exec(file)).toBe(false)
  })

  posixOnly('checks the unpacked twin of an archive path', () => {
    const unpacked = path.join(root, 'app.asar.unpacked', 'node_modules', 'node-pty')
    const file = path.join(unpacked, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    fs.chmodSync(file, 0o644)
    const inArchive = path.join(root, 'app.asar', 'node_modules', 'node-pty')
    expect(ensurePtyHelperExecutable(inArchive, 'darwin').fixed).toEqual([file])
  })

  it('is asked before the first shell is started, once', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/terminal-manager.ts'), 'utf8')
    expect(src.indexOf('ensurePtyHelperOnce()')).toBeGreaterThan(-1)
    expect(src.indexOf('  ensurePtyHelperOnce()\n')).toBeLessThan(src.indexOf('const term = pty.spawn('))
    expect(src).toMatch(/if \(ptyHelperChecked\) return/)
  })
})
