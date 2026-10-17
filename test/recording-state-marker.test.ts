import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { markerForOpen } from '../src/core/recording-state-marker'
import { initDB, closeDB } from '../src/core/db/index'
import { lastRecordingSubtype } from '../src/core/db/events'
import { addExportEvent } from './helpers/export-fixtures'

// Pause is an in-memory flag. Opening a project must leave its record saying
// what the flag will not: a pause carried in, or a pause that did not survive.

describe('what a project needs written when it is opened', () => {
  it('records a pause that is in effect but not in this project', () => {
    expect(markerForOpen(true, null)).toMatchObject({ subtype: 'recording_paused', source: 'carried-over' })
    expect(markerForOpen(true, 'recording_resumed')).toMatchObject({ subtype: 'recording_paused' })
  })
  it('does not repeat a pause this project already holds', () => {
    expect(markerForOpen(true, 'recording_paused')).toBeNull()
  })
  it('closes a pause that did not survive a restart, so the timeline stops drawing it open', () => {
    expect(markerForOpen(false, 'recording_paused')).toMatchObject({ subtype: 'recording_resumed', source: 'project-open' })
  })
  it('writes nothing for a project that was recording and still is', () => {
    expect(markerForOpen(false, null)).toBeNull()
    expect(markerForOpen(false, 'recording_resumed')).toBeNull()
  })
})

describe('lastRecordingSubtype', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-recstate-')); initDB(dir) })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
  const mark = (id: string, ts: number, subtype: string): void =>
    addExportEvent('events', id, ts, { agentType: 'system', subtype })

  it('is null for a project that never paused', () => {
    mark('c', 1000, 'config_changed')
    expect(lastRecordingSubtype()).toBeNull()
  })
  it('is the most recent pause or resume, ignoring other system events', () => {
    mark('p', 1000, 'recording_paused')
    mark('r', 2000, 'recording_resumed')
    mark('p2', 3000, 'recording_paused')
    mark('later', 4000, 'config_changed')
    expect(lastRecordingSubtype()).toBe('recording_paused')
  })
  it('reads resumed when the last word was resume', () => {
    mark('p', 1000, 'recording_paused')
    mark('r', 2000, 'recording_resumed')
    expect(lastRecordingSubtype()).toBe('recording_resumed')
  })
})
