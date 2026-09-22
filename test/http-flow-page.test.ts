import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let getDB: typeof import('../src/core/db').getDB
let queryHttpFlowPage: typeof import('../src/core/db/events').queryHttpFlowPage
let available = false
try {
  const db = await import('../src/core/db')
  const events = await import('../src/core/db/events')
  initDB = db.initDB; closeDB = db.closeDB; getDB = db.getDB
  queryHttpFlowPage = events.queryHttpFlowPage; available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

function add(flowId: string, ts: number, target: string): void {
  const stmt = getDB().prepare(`INSERT INTO events_logged
    (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at)
    VALUES (?,?,?,?,?,'scanner',?,?,?,?,?,?)`)
  stmt.run(`${flowId}-req`, ts, 'e', 's', 'op', 'http_request_start', '', '', target,
    JSON.stringify({ subtype: 'http_request_start', flow_id: flowId, host: target, url: `http://${target}/${flowId}` }), ts)
  stmt.run(`${flowId}-res`, ts + 1, 'e', 's', 'op', 'http_response', '', '', target,
    JSON.stringify({ subtype: 'http_response', flow_id: flowId, host: target, status: 200 }), ts + 1)
}

describeDB('queryHttpFlowPage', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-http-page-')); initDB(dir) })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('pages complete flows without duplicates', () => {
    for (let i = 0; i < 11; i++) add(`f-${i}`, 1000 + i * 10, 'target.test')
    const flowIds: string[] = []
    let cursor: string | null = null
    for (;;) {
      const page = queryHttpFlowPage({ limit: 4, cursor })
      const counts = new Map<string, number>()
      for (const event of page.items) {
        const id = String(event.data.flow_id)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      expect([...counts.values()].every((count) => count === 2)).toBe(true)
      flowIds.push(...counts.keys())
      if (!page.hasMore) break
      cursor = page.nextCursor
    }
    expect(flowIds).toHaveLength(11)
    expect(new Set(flowIds).size).toBe(11)
  })

  it('applies scope before the flow limit', () => {
    for (let i = 0; i < 3; i++) add(`in-${i}`, 100 + i * 10, `10.0.0.${i + 1}`)
    for (let i = 0; i < 8; i++) add(`out-${i}`, 1000 + i * 10, `192.168.1.${i + 1}`)
    const page = queryHttpFlowPage({
      limit: 3, inScopeOnly: true,
      scope: { targets: ['10.0.0.0/24'], excludeTargets: [] }
    })
    expect(page.flowCount).toBe(3)
    expect(page.items.every((event) => event.targetId?.startsWith('10.0.0.'))).toBe(true)
  })
})
