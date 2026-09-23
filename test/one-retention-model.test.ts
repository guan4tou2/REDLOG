import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig } from '../src/core/config'

// Spec 028: every store's retention knobs live under `retention.<store>` with
// the same two names — `keepDays` (age) and `maxBytes` (size pressure). Before
// this, the same two ideas were spelled five ways across four sections
// (`terminal.castKeepDays`, `terminal.castStoreMaxBytes`, `screenshots.keepDays`,
// `httpBodies.maxBytes`, and an undeclared `agentTranscripts.keepDays`), and
// `screenshots` (retention) sat next to `screenshot` (capture cadence).

let tmpDir: string
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-retention-model-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('one retention model', () => {
  it('declares every store under retention with keepDays/maxBytes, all defaulting to keep forever', () => {
    const c = loadConfig(tmpDir) as unknown as Record<string, Record<string, unknown>>
    expect(c.retention).toMatchObject({
      casts: { keepDays: 0, maxBytes: 0 },
      screenshots: { keepDays: 0, maxBytes: 0 },
      httpBodies: { keepDays: 0, maxBytes: 0 },
      agentTranscripts: { keepDays: 0 },
      loggedTier: { keepDays: 0, sweepIntervalHours: 24 },
      bookmarks: { keepDays: 0 }
    })
  })

  it('has no retention knobs outside the retention section', () => {
    const c = loadConfig(tmpDir) as unknown as Record<string, unknown>
    expect(c).not.toHaveProperty('screenshots')
    expect(c).not.toHaveProperty('httpBodies')
    // The per-recording truncation cap is a capture limit, not retention.
    expect(Object.keys(c.terminal as object)).toEqual(['maxCastBytes'])
  })

  it('no source or settings page reads the old spellings', () => {
    const roots = ['src']
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
      }
    }
    roots.forEach((r) => walk(path.join(__dirname, '..', r)))
    const old = /castKeepDays|castStoreMaxBytes|config\.(screenshots|httpBodies|agentTranscripts)\b|terminal\?\.\s*cast/
    const hits = files.filter((f) => old.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/'))
    expect(hits).toEqual([])
  })
})
