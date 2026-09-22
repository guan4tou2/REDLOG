import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  configureFileWatcher,
  stopFileWatcher,
  _getWatcherStateForTests
} from '../src/main/services/file-watcher'
import { initDB, closeDB } from '../src/core/db/index'
import { ensurePrimaryOperator, generateToken } from '../src/core/db/operators'
import { queryEvents } from '../src/core/db/events'
import { ingestEvent, _resetIngest } from '../src/core/ingest'

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

  it('starts a watcher when enabled + paths + attribution are all present', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-'))
    try {
      await configureFileWatcher({
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

  it('flipping enabled off stops the watcher', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-'))
    try {
      await configureFileWatcher({
        enabled: true, watchPaths: [tmp],
        engagementId: 'e1', operatorId: 'op1'
      })
      expect(_getWatcherStateForTests().watching).toBe(true)
      await configureFileWatcher({ enabled: false })
      expect(_getWatcherStateForTests().watching).toBe(false)
    } finally {
      stopFileWatcher()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('file-watcher / command correlation integration', () => {
  it('records a delayed file notification as a candidate, not a cause', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-db-'))
    const watchedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fw-watch-'))
    try {
      initDB(projectDir)
      const operatorId = ensurePrimaryOperator('fw-op', 'File watcher', generateToken()).id
      const commandData = {
        command: 'nmap -oA result 10.0.0.8', terminalId: 'fw-terminal', pid: 818,
        cwd: watchedDir
      }
      const command = ingestEvent('shell', { subtype: 'command_start', ...commandData }, {
        engagementId: 'fw-engagement', operatorId
      })!
      ingestEvent('shell', { subtype: 'command_end', ...commandData }, {
        engagementId: 'fw-engagement', operatorId
      })
      await configureFileWatcher({
        enabled: true, watchPaths: [watchedDir], engagementId: 'fw-engagement', operatorId
      })
      fs.writeFileSync(path.join(watchedDir, 'result.xml'), '<nmaprun/>')

      let fileEvent: ReturnType<typeof queryEvents>[number] | undefined
      const deadline = Date.now() + 3_000
      while (!fileEvent && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        fileEvent = queryEvents({ agentType: 'file_transfer', limit: 20 })
          .find((event) => event.data.path === path.join(watchedDir, 'result.xml'))
      }
      expect(fileEvent).toBeDefined()
      expect(fileEvent!.data._causes).toBeUndefined()
      expect(fileEvent!.data.related_commands).toEqual([{
        event_id: command.id, method: 'cwd-near-command-end', state: 'recent'
      }])
    } finally {
      stopFileWatcher()
      _resetIngest()
      try { closeDB() } catch { /* already closed */ }
      fs.rmSync(projectDir, { recursive: true, force: true })
      fs.rmSync(watchedDir, { recursive: true, force: true })
    }
  })
})
