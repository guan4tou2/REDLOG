import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  configureFileWatcher,
  stopFileWatcher,
  _getWatcherStateForTests
} from '../src/main/services/file-watcher'

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the file-watcher lifecycle. We don't want to spin up a real
// chokidar watcher in tests (it needs fs events + engagement/operator ids
// tied to a real DB), so these focus on the state machine: enabled/disabled,
// path handling, restart semantics.
//
// Full end-to-end coverage would be an e2e test against a real project db.
// ─────────────────────────────────────────────────────────────────────────────

describe('file-watcher / lifecycle', () => {
  afterEach(() => stopFileWatcher())

  it('starts disabled by default', () => {
    const s = _getWatcherStateForTests()
    expect(s.enabled).toBe(false)
    expect(s.watching).toBe(false)
  })

  it('no-ops when enabled with empty watchPaths', () => {
    configureFileWatcher({
      enabled: true, watchPaths: [], ignorePatterns: [],
      engagementId: 'e1', operatorId: 'op1'
    })
    const s = _getWatcherStateForTests()
    expect(s.enabled).toBe(true)
    expect(s.watching).toBe(false)  // nothing to watch — silent no-op
  })

  it('no-ops when enabled with no engagement id (config error)', () => {
    configureFileWatcher({
      enabled: true, watchPaths: ['/tmp'],
      engagementId: '', operatorId: 'op1'
    })
    const s = _getWatcherStateForTests()
    expect(s.watching).toBe(false)  // safety: no attribution → don't watch
  })

  it('starts a watcher when enabled + paths + attribution are all present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-'))
    try {
      configureFileWatcher({
        enabled: true, watchPaths: [tmp],
        engagementId: 'e1', operatorId: 'op1'
      })
      const s = _getWatcherStateForTests()
      expect(s.watching).toBe(true)
      expect(s.watchPaths).toEqual([tmp])
    } finally {
      stopFileWatcher()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('flipping enabled off stops the watcher', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-'))
    try {
      configureFileWatcher({
        enabled: true, watchPaths: [tmp],
        engagementId: 'e1', operatorId: 'op1'
      })
      expect(_getWatcherStateForTests().watching).toBe(true)
      configureFileWatcher({ enabled: false })
      expect(_getWatcherStateForTests().watching).toBe(false)
    } finally {
      stopFileWatcher()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
