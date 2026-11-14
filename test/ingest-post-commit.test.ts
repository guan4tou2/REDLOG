// A step after the commit that throws does not fail the write (ingest.ts
// afterCommit, Spec 071 FR-097 third and fourth review). The row is written,
// so the API answers 201, the steps after the failing one still run, and the
// failure is a pipeline warning: capture health's verdict does not go dark, as
// it would for "writing evidence is broken" (noteDbError).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { requires } from './helpers/requires'
import { interceptHttp, openRuntime, storedRows } from './helpers/ingest-delivery'

const sqlite = requires('better-sqlite3')

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-post-commit-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

sqlite.describe('a step after the commit fails', () => {
  let dir = ''
  beforeEach(() => { interceptHttp(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-post-commit-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  sqlite.it('the scope check throws: 201, the row stored, the pivot after it still written, a warning noted and the verdict not dark', async () => {
    const rt = await openRuntime(dir)
    const ingest = await import('../src/core/ingest')
    const health = await import('../src/core/capture-health')
    let dispatched = 0
    ingest.configureIngest({ alertRuntime: { dispatchTargetHit: () => { dispatched++; throw new Error('scope dispatcher down') } } })
    const before = health.getCaptureHealth()
    try {
      await rt.api({ agent_type: 'shell', data: { subtype: 'command_start', command: 'ssh -D 1080 -N user@10.0.0.5', terminalId: 't1', pid: 7 } }, 201)
      const after = health.getCaptureHealth(Date.now() + 1)
      expect(dispatched).toBe(1)
      // Not `dark`, which is what a write failure reads as. Not compared with
      // `before`: on the CI runners the verdict is already `dark` before this
      // row and `healthy` after it, so "unchanged" fails there for a reason
      // that has nothing to do with the warning.
      expect(after.verdict).not.toBe('dark')
      expect(after.lastDbError).toBeUndefined()
      expect(after.dbErrorTotal).toBe(before.dbErrorTotal)
      expect(after.lastPipelineWarning).toMatchObject({ source: 'ingest-post-commit', message: 'scope dispatcher down' })
      expect(after.pipelineWarningTotal).toBe((before.pipelineWarningTotal ?? 0) + 1)
    } finally { await rt.close() }
    const rows = await storedRows(dir)
    const kinds = rows.filter((r) => r.table === 'events').map((r) => `${String(r.row.agent_type)}:${String(r.data.subtype)}`)
    // The pivot companion is written after the scope step: the steps after it ran.
    expect(kinds).toEqual(['shell:command_start', 'pivot:socks_up'])
  })
})
