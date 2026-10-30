import { it, expect, describe } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// #459: an event pinned to a project that is no longer open is refused, and
// the refusal leaves a bounded, content-free capture_gap in the spool for the
// project it belongs to.
it('records a refusal after a project switch as a spooled gap for the owner', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-switch-gap-check.py'], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('switch gap checks passed')
})

let db: typeof import('../src/core/db/index') | null = null
try { db = await import('../src/core/db/index') } catch { /* native module unavailable */ }

// And the app reads it back through the spool drain's own path, into A only.
describe.skipIf(!db)('a project-switched gap after A reopens', () => {
  it('is in A with the exact refused count, nothing of the content, and none of it in B', async () => {
    const { replaySpoolDirectory } = await import('../src/core/spool-replay')
    const { ingest } = await import('../src/core/ingest')
    const { queryEvents } = await import('../src/core/db/events')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-switch-gap-'))
    const spool = path.join(root, 'pending')
    try {
      const run = spawnSync('python3', ['test/fixtures/mitm-switch-gap-check.py', spool], { encoding: 'utf8', timeout: 10000 })
      expect(run.status, run.stderr).toBe(0)
      db!.initDB(path.join(root, 'project'))
      const other = replaySpoolDirectory(spool, { engagementId: 'B', operatorId: 'op-B' }, () => true)
      expect(other.replayed).toBe(0)
      const replay = replaySpoolDirectory(spool, { engagementId: 'A', operatorId: 'op-A' }, (e) =>
        !!ingest({ agentType: e.agentType, data: e.data, engagementId: e.engagementId, operatorId: e.operatorId,
          envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } } }).event)
      expect(replay.replayed).toBeGreaterThan(0)
      const gaps = queryEvents({ limit: -1 }).filter((e) => e.data.subtype === 'capture_gap' && e.data.reason === 'project-switched')
      expect(gaps.length).toBe(replay.replayed)
      expect(gaps.every((e) => e.engagementId === 'A')).toBe(true)
      expect(gaps.reduce((n, e) => n + Number(e.data.skipped_units), 0)).toBe(1005)
      expect(JSON.stringify(gaps)).not.toMatch(/SECRET|private\.test|UFJJVkFURS1CWVRFUw/)
    } finally {
      try { db!.closeDB() } catch { /* */ }
      // Its own handle; left open, Windows keeps the file locked.
      try { (await import('../src/core/http-body-index')).closeHttpBodyIndex() } catch { /* */ }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
