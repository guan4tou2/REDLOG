import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initDB, closeDB, getDB, getReadonlyDB } from '../src/core/db/index'
import { addExportEvent } from './helpers/export-fixtures'
import { takeExportSnapshot } from '../src/core/export-plan'
import { exportHar } from '../src/core/har-export'
import { writeApprovedHar } from '../src/core/har-export-stream'
import { iterateSnapshotEvents } from '../src/core/export-selection'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-har-stream-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
const event = (id: string, timestamp: number, data: Record<string, unknown>) => addExportEvent('events_logged', id, timestamp,
  { agentType: 'scanner', targetId: 'example.test', subtype: String(data.subtype), data })

it('streams the exact approved HAR bytes across page boundaries, duplicate requests, tied times and partial streams', () => {
  getDB().transaction(() => {
    for (let i = 0; i < 530; i++) {
      event(`req-${i}`, 1000 + i, { subtype: 'http_request_start', flow_id: `f-${i}`, method: 'GET', url: `https://example.test/${i}` })
      event(`res-${i}`, 2000 + i, { subtype: 'http_response', flow_id: `f-${i}`, status: 200, content_length: 2,
        response_body: { encoding: 'text', data: 'ok', size: 2 } })
    }
    event('duplicate', 500, { subtype: 'http_request_start', flow_id: 'f-0', method: 'POST', url: 'https://example.test/old' })
    event('tie', 500, { subtype: 'http_request_start', flow_id: 'tie', method: 'GET', url: 'https://example.test/tie' })
    for (const [id, flow, ts, sub] of [['chunk', 'partial', 50, 'http_response_chunk'], ['ws', 'partial', 40, 'ws_message'],
      ['end', 'partial', 1, 'websocket_end'], ['ws-only', 'ws-only', 40, 'ws_message']] as const) {
      event(id, ts, { subtype: sub, flow_id: flow, seq: 1, message_count: 1, url: 'https://example.test/events',
        response_body: { encoding: 'text', data: 'tail', size: 4 }, ws_body: { encoding: 'text', data: 'message', size: 7 } })
    }
  })()
  const snapshot = takeExportSnapshot()
  const includeEventIds = new Set([...iterateSnapshotEvents(snapshot)].map(event => event.id))
  event('not-approved', 99, { subtype: 'http_request_start', flow_id: 'new', url: 'https://example.test/not-approved' })
  const options = { snapshot, includeEventIds }
  const file = path.join(dir, 'out.har')
  writeApprovedHar(file, options)
  expect(fs.readFileSync(file, 'utf8')).toBe(exportHar(options))
  expect(() => writeApprovedHar(file, options)).toThrow(/exist/i)
})

// #695: the per-flow lookup named no subtype, so neither partial flow_id index
// applied and every flow scanned every scanner row — a whole-project HAR of
// 3 000 flows beside 30 000 other scanner rows took 43 s against 0.15 s for
// exportHar. Asserted on the query plan, which does not depend on the machine.
it('looks each flow up through the flow_id indexes, not a scan of the scanner rows', () => {
  for (let i = 0; i < 3; i++) {
    event(`req-${i}`, 1000 + i, { subtype: 'http_request_start', flow_id: `f-${i}`, method: 'GET', url: `https://example.test/${i}` })
    event(`chunk-${i}`, 1500 + i, { subtype: 'http_response_chunk', flow_id: `f-${i}`, seq: 1, response_body: { encoding: 'text', data: 'x', size: 1 } })
  }
  const snapshot = takeExportSnapshot()
  const includeEventIds = new Set([...iterateSnapshotEvents(snapshot)].map(event => event.id))
  const db = getReadonlyDB()
  const prepare = vi.spyOn(db, 'prepare')
  let prepared: string[] = []
  try {
    writeApprovedHar(path.join(dir, 'plan.har'), { snapshot, includeEventIds })
    prepared = prepare.mock.calls.map(([sql]) => String(sql))
  } finally { prepare.mockRestore() }
  const flowSql = prepared.filter(sql => sql.includes("'$.flow_id'"))
  expect(flowSql.length).toBeGreaterThan(0)
  for (const sql of flowSql) {
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, (_, i) => i % 2 === 0 ? 'f-0' : snapshot.loggedMaxRowId)
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(row => row.detail)
    const reads = plan.filter(detail => /\b(SCAN|SEARCH) events_logged\b/.test(detail))
    expect(reads.length, plan.join(' | ')).toBeGreaterThan(0)
    for (const detail of reads) expect(detail).toMatch(/idx_events_logged_(http_flow|stream_flows) \(<expr>=\?/)
  }
})

it('writes the same empty HAR without inventing an exchange or a partial flow', () => {
  const options = { snapshot: takeExportSnapshot(), includeEventIds: new Set<string>() }
  const file = path.join(dir, 'empty.har')
  writeApprovedHar(file, options)
  expect(fs.readFileSync(file, 'utf8')).toBe(exportHar(options))
})
