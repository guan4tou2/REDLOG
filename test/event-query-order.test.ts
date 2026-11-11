import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { queryEvents } from '../src/core/db/events'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-event-order-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

function add(id: string, ts: number, table: 'events' | 'events_logged'): void {
  getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${table === 'events' ? ',hash,prev_hash' : ''})
    VALUES (?,?,'eng','binding','operator','marker','','host',NULL,NULL,'{}',?${table === 'events' ? ",'fixture-hash',NULL" : ''})`).run(id, ts, ts)
}

it('keeps the rows nearest the lower bound when asked for the oldest', () => {
  for (let i = 0; i < 6; i++) add(`c${i}`, 100 + i * 10, 'events')
  for (let i = 0; i < 6; i++) add(`l${i}`, 105 + i * 10, 'events_logged')
  const window = { since: 100, before: 170, limit: 4 }
  // Default: the newest rows of the window, newest first.
  expect(queryEvents(window).map(e => e.id)).toEqual(['l5', 'c5', 'l4', 'c4'])
  // Oldest: the rows nearest the start, in clock order, across both tiers.
  expect(queryEvents({ ...window, order: 'oldest' }).map(e => e.id)).toEqual(['c0', 'l0', 'c1', 'l1'])
  expect(queryEvents({ ...window, order: 'oldest', tier: 'logged' }).map(e => e.id)).toEqual(['l0', 'l1', 'l2', 'l3'])
  expect(queryEvents({ ...window, order: 'oldest', tier: 'chained' }).map(e => e.id)).toEqual(['c0', 'c1', 'c2', 'c3'])
})
