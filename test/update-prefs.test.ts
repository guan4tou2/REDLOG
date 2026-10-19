import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAutoCheckEnabled, setAutoCheckEnabled } from '../src/main/services/update-prefs'

// The check at launch is on unless the operator turned it off, and turning it
// back on needs no migration: the switch is only whether a file exists.

describe('auto-check preference', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-prefs-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('is on by default, including in a directory that does not exist yet', () => {
    expect(isAutoCheckEnabled(dir)).toBe(true)
    expect(isAutoCheckEnabled(path.join(dir, 'missing'))).toBe(true)
  })

  it('turns off and on again, and either twice is harmless', () => {
    setAutoCheckEnabled(dir, false)
    setAutoCheckEnabled(dir, false)
    expect(isAutoCheckEnabled(dir)).toBe(false)
    setAutoCheckEnabled(dir, true)
    setAutoCheckEnabled(dir, true)
    expect(isAutoCheckEnabled(dir)).toBe(true)
  })

  it('creates the directory when switching off', () => {
    const nested = path.join(dir, 'a', 'b')
    setAutoCheckEnabled(nested, false)
    expect(isAutoCheckEnabled(nested)).toBe(false)
  })
})
