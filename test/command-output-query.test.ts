import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db/index'
import { takeExportSnapshot } from '../src/core/export-plan'
import { queryCommandOutput, queryEventsPage } from '../src/core/db/events'
import { getDoNotExportIds, toggleDoNotExport } from '../src/core/db/do-not-export'
import { insertFixtureRow } from './helpers/timeline-query-fixture'

// Background output is stored as rows of its own and read back by the command
// that printed it. Chunks arrive out of order across the two tiers; the reader
// owes the detail pane `seq` order and nothing from another command.

describe('queryCommandOutput', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cmdout-')); initDB(dir) })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const chunk = (id: string, ts: number, data: Record<string, unknown>, table: 'events' | 'events_logged' = 'events'): void =>
    insertFixtureRow({ table, id, timestamp: ts, agentType: 'shell', subtype: 'command_output', operatorId: 'o', targetId: null, data })

  it('returns one command’s late chunks in seq order, from both tiers', () => {
    chunk('b', 2, { command_id: 'c1', late: true, seq: 2, stdout: 'two\n' }, 'events_logged')
    chunk('a', 1, { command_id: 'c1', late: true, seq: 1, stdout: 'one\n' })
    chunk('f', 3, { command_id: 'c1', late: true, seq: 3, stream: 'both', final: true, late_bytes: 8 })
    chunk('x', 4, { command_id: 'other', late: true, seq: 1, stdout: 'not mine\n' })
    chunk('n', 5, { command_id: 'c1', seq: 9, stdout: 'a non-late row\n' })
    const rows = queryCommandOutput('c1')
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'f'])
    expect(rows[2].data.final).toBe(true)
  })

  it('deduplicates foreground resends before a bounded preview and retains the full export query', () => {
    for (let seq = 1; seq <= 5; seq++) {
      chunk(`f-${seq}`, seq, { command_id: 'foreground', streamed: true, late: false, seq, stdout: `${seq}` })
      chunk(`dup-${seq}`, seq + 1, { command_id: 'foreground', streamed: true, late: false, seq, stdout: 'duplicate' }, 'events_logged')
    }
    expect(queryCommandOutput('foreground', 3).map(r => r.id)).toEqual(['f-1', 'f-2', 'f-3'])
    expect(queryCommandOutput('foreground', -1)).toHaveLength(5)
  })

  it('keeps foreground chunks inside the command projection and honors its export exclusion', () => {
    insertFixtureRow({ table: 'events', id: 'end', timestamp: 1, agentType: 'shell', subtype: 'command_end', operatorId: 'o', targetId: null,
      data: { command_id: 'stream', subtype: 'command_end', output_streamed: true, command: 'tool' } })
    chunk('stream-chunk', 2, { command_id: 'stream', subtype: 'command_output', streamed: true, late: false, seq: 1, stdout: 'private' })
    expect(queryEventsPage({ excludeHousekeeping: true }).items.map(row => row.id)).toEqual(['end'])
    toggleDoNotExport('end')
    expect(getDoNotExportIds().has('stream-chunk')).toBe(true)
  })

  it('applies the export snapshot before deduplicating a later backdated resend', () => {
    chunk('approved', 10, { command_id: 'snapshot', streamed: true, seq: 1, stdout: 'approved' })
    const snapshot = takeExportSnapshot()
    chunk('unapproved', 1, { command_id: 'snapshot', streamed: true, seq: 1, stdout: 'new' })
    expect(queryCommandOutput('snapshot', -1, snapshot).map(r => r.id)).toEqual(['approved'])
  })

  it('returns nothing for a command with no background output', () => {
    expect(queryCommandOutput('nope')).toEqual([])
  })
})
