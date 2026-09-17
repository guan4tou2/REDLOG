import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { restrictToOwner } from '../src/core/fs-acl'

const IS_WIN = process.platform === 'win32'

describe('restrictToOwner', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is a no-op on non-win32', { skip: IS_WIN }, () => {
    const f = path.join(tmpDir, 'secret')
    fs.writeFileSync(f, 'data', { mode: 0o600 })
    restrictToOwner(f)
    const stat = fs.statSync(f)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it.skipIf(!IS_WIN)('restricts file ACL on Windows', () => {
    const f = path.join(tmpDir, 'secret')
    fs.writeFileSync(f, 'data')
    restrictToOwner(f)
    const out = execFileSync('icacls', [f], { encoding: 'utf-8' })
    const user = process.env.USERNAME!
    expect(out).toContain(user)
    expect(out).not.toContain('Everyone')
    expect(out).not.toContain('BUILTIN\\Users')
  })

  it.skipIf(!IS_WIN)('restricts directory ACL on Windows', () => {
    const d = path.join(tmpDir, 'keys')
    fs.mkdirSync(d)
    restrictToOwner(d)
    const out = execFileSync('icacls', [d], { encoding: 'utf-8' })
    const user = process.env.USERNAME!
    expect(out).toContain(user)
    expect(out).not.toContain('Everyone')
    expect(out).not.toContain('BUILTIN\\Users')
  })
})
