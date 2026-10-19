import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeUpdateMarker, readUpdateMarker, clearUpdateMarker, judgeUpdateOutcome, versionAtLeast } from '../src/main/services/update-marker'

// Spec 061 FR-006 / FR-009: the launch after an update decides whether it
// worked by the version that is running, not by the restart having been asked.

describe('update marker', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-marker-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const marker = { fromVersion: '1.0.0', toVersion: '1.1.0', at: 5, projectDir: '/p/acme' }

  it('round-trips, creating the directory, and leaves no temp file behind', () => {
    const nested = path.join(dir, 'a', 'b')
    writeUpdateMarker(nested, marker)
    expect(readUpdateMarker(nested)).toEqual({ ...marker, method: 'in-app' })
    expect(fs.readdirSync(nested)).toEqual(['update-pending.json'])
  })

  it('reads nothing when there is no marker, or when it is damaged or incomplete', () => {
    expect(readUpdateMarker(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'update-pending.json'), '{not json')
    expect(readUpdateMarker(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'update-pending.json'), JSON.stringify({ fromVersion: '1' }))
    expect(readUpdateMarker(dir)).toBeNull()
  })

  it('keeps a null project, and clears without complaint twice', () => {
    writeUpdateMarker(dir, { ...marker, projectDir: null })
    expect(readUpdateMarker(dir)?.projectDir).toBeNull()
    clearUpdateMarker(dir)
    clearUpdateMarker(dir)
    expect(readUpdateMarker(dir)).toBeNull()
  })

  it('judges by the running version: the target is completed, anything else is not applied', () => {
    expect(judgeUpdateOutcome(marker, '1.1.0').kind).toBe('completed')
    expect(judgeUpdateOutcome(marker, '1.0.0')).toMatchObject({ kind: 'not-applied', actualVersion: '1.0.0', toVersion: '1.1.0' })
    // Further than aimed for is still not stuck on the old version.
    expect(judgeUpdateOutcome(marker, '1.2.0').kind).toBe('completed')
    expect(judgeUpdateOutcome(marker, '1.0.9').kind).toBe('not-applied')
  })

  it('compares versions as numbers, not as text', () => {
    expect(versionAtLeast('1.10.0', '1.9.0')).toBe(true)
    expect(versionAtLeast('1.9.0', '1.10.0')).toBe(false)
    expect(versionAtLeast('v2.0', '2.0.0')).toBe(true)
    expect(versionAtLeast('1.0.0-rc1', '1.0.0')).toBe(true)
  })

  it('remembers whether the operator only went to the download page', () => {
    writeUpdateMarker(dir, { ...marker, method: 'manual' })
    expect(readUpdateMarker(dir)?.method).toBe('manual')
    writeUpdateMarker(dir, marker)
    expect(readUpdateMarker(dir)?.method).toBe('in-app')
  })
})
