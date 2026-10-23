import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { queryHttpFlowPage } from '../src/core/db/events'

// Opt-in like timeline-query-perf: this measures a local desktop, not shared CI.
// Small metadata-only rows hid sorting full response bodies in the flow query.
describe.skipIf(process.env.REDLOG_PERF !== '1')('HTTP query budget with inline bodies', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-http-perf-'))
    initDB(dir)
    const db = getDB()
    const insert = db.prepare(`INSERT INTO events_logged
      (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at)
      VALUES (?,?,'perf','session','op','scanner',?,'','',?,?,?)`)
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const host = `host-${i % 10}.example.test`
        const common = { flow_id: `f${i}`, host, url: `https://${host}/api/${i}`, method: 'POST' }
        insert.run(`req${i}`, 1000 + i * 2, 'http_request_start', host, JSON.stringify({ ...common, subtype: 'http_request_start', request_body: 'request ' + 'x'.repeat(4000) }), 1000 + i * 2)
        insert.run(`res${i}`, 1001 + i * 2, 'http_response', host, JSON.stringify({ ...common, subtype: 'http_response', status: 200 + i % 4 * 100, content_type: 'application/json', response_body: 'response ' + 'y'.repeat(4000) }), 1001 + i * 2)
      }
    })()
  }, 120_000)
  afterAll(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  for (const [name, http] of [['all', {}], ['4xx', { statusPrefix: '4' }]] as const) {
    it(`first 500 complete flows within 200 ms: ${name}`, () => {
      queryHttpFlowPage({ limit: 500, http })
      const times = []
      for (let i = 0; i < 5; i++) {
        const start = performance.now()
        const page = queryHttpFlowPage({ limit: 500, http })
        times.push(performance.now() - start)
        expect(page.flowCount).toBe(500)
        expect(page.items).toHaveLength(1000)
        expect(page.items.find(event => event.data.subtype === 'http_response')?.data.response_body).toBe('response ' + 'y'.repeat(4000))
      }
      const median = times.sort((a, b) => a - b)[2]
      console.log(`HTTP 5000 flows/40MB body, ${name}, median of 5 warm runs: ${median.toFixed(1)} ms; ${os.cpus()[0]?.model}, ${os.platform()}, ${process.version}`)
      expect(median).toBeLessThan(200)
    })
  }
})
