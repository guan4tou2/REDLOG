// Ingest throughput — PERF-AUDIT-2026-11 §3.
//
//   node docs/perf-audit-2026-11/run.mjs bench-ingest.ts [--prof] -- <mode> [cycles] [concurrency]
//
// modes
//   inproc   ingest() called directly, as in-process producers do
//   http     POST /api/events over keep-alive HTTP, `concurrency` in flight
//   spool    write `cycles` worth of hook spool files, then replay them with
//            the same emit main/index.ts uses on project open
//   stages   time the separable stages on the same payloads
//
// The project, operator and signing key are real (initDB + startApiServer, as
// test/api-server.test.ts does), so every chained row is hashed and signed.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { initDB, getDB } from '../../src/core/db/index'
import * as api from '../../src/core/api-server'
import { configureIngest, ingest } from '../../src/core/ingest'
import { LootDetector } from '../../src/core/loot-detector'
import { getPrimaryOperator } from '../../src/core/db/operators'
import { canonicalStringify } from '../../src/core/db/event-write'
import { signEvent } from '../../src/core/signing'
import { replaySpoolDirectory } from '../../src/core/spool-replay'
import { cycle, type WorkEvent } from './workload'

const [mode = 'inproc', cyclesArg = '2000', concArg = '8'] = process.argv.slice(2)
// PERF_LANES=shell,agent,dns restricts the mix to those agent types (scanner = the HTTP lane).
const LANES = process.env.PERF_LANES ? new Set(process.env.PERF_LANES.split(',')) : null
const cycleOf = (i: number): WorkEvent[] => LANES ? cycle(i).filter((e) => LANES.has(e.agentType)) : cycle(i)
const CYCLES = Number(cyclesArg)
const CONC = Number(concArg)
const work = process.env.PERF_WORK!
const projectDir = path.join(work, 'project')
fs.mkdirSync(projectDir, { recursive: true })

const ENG = 'eng-perf'
initDB(projectDir)
const loot = new LootDetector()
loot.configure({ engagementId: ENG, operatorId: 'pending' })
api.configureApi({ engagementId: ENG, operatorId: 'pending', operatorName: 'Perf', lootDetector: loot })
let dispatches = 0
configureIngest({ lootDetector: loot, alertRuntime: { dispatchTargetHit: () => { dispatches++ } } })

const mb = (n: number): string => (n / 1048576).toFixed(1)
const dbBytes = (): number => ['timeline.db', 'timeline.db-wal'].reduce((s, f) => {
  try { return s + fs.statSync(path.join(projectDir, f)).size } catch { return s }
}, 0)
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
function report(label: string, n: number, ms: number, lat?: number[]): void {
  const { rss, heapUsed, external } = process.memoryUsage()
  console.log(JSON.stringify({
    label, events: n, ms: Math.round(ms), eventsPerSec: Math.round((n / ms) * 1000),
    ...(lat ? { p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2), max: +pct(lat, 100).toFixed(2) } : {}),
    dbMiB: +mb(dbBytes()), rssMiB: +mb(rss), heapMiB: +mb(heapUsed), externalMiB: +mb(external)
  }))
}

async function main(): Promise<void> {
  const port = await api.startApiServer(0)
  api.onApiProjectOpen()
  const op = getPrimaryOperator()!
  const token = api.getApiToken()

  if (mode === 'inproc') {
    const WINDOW = 250
    let n = 0
    let t0 = performance.now()
    let windowStart = t0
    let windowN = 0
    const lat: number[] = []
    for (let i = 0; i < CYCLES; i++) {
      for (const ev of cycleOf(i)) {
        const s = performance.now()
        ingest({ agentType: ev.agentType, data: ev.data, operatorId: op.id, engagementId: ENG, targetId: ev.targetId,
          envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
        lat.push(performance.now() - s)
        n++; windowN++
      }
      // Yield once per cycle, as the app does between requests. Without it,
      // better-sqlite3's statement finalizers (N-API, deferred to the event
      // loop) never run and RSS measures the loop, not ingest (§3.3).
      if (process.env.PERF_NO_YIELD !== '1') await new Promise((r) => setImmediate(r))
      if ((i + 1) % WINDOW === 0) {
        report(`inproc@${n}`, windowN, performance.now() - windowStart, lat.splice(0))
        windowStart = performance.now(); windowN = 0
      }
    }
    report('inproc total', n, performance.now() - t0)
  }

  if (mode === 'http') {
    const agent = new http.Agent({ keepAlive: true, maxSockets: CONC })
    const post = (ev: WorkEvent): Promise<number> => new Promise((resolve, reject) => {
      const body = JSON.stringify({ agent_type: ev.agentType, data: ev.data, ...(ev.targetId ? { target_id: ev.targetId } : {}) })
      const s = performance.now()
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'POST', agent,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } }, (res) => {
        res.resume()
        res.on('end', () => (res.statusCode === 201 || res.statusCode === 409) ? resolve(performance.now() - s) : reject(new Error(`HTTP ${res.statusCode}`)))
      })
      req.on('error', reject)
      req.end(body)
    })
    const all: WorkEvent[] = []
    for (let i = 0; i < CYCLES; i++) all.push(...cycleOf(i))
    const WINDOW = 2750
    let next = 0
    let done = 0
    const t0 = performance.now()
    let windowStart = t0
    let lat: number[] = []
    const worker = async (): Promise<void> => {
      while (next < all.length) {
        const ev = all[next++]
        lat.push(await post(ev))
        done++
        if (done % WINDOW === 0) {
          report(`http c=${CONC} @${done}`, WINDOW, performance.now() - windowStart, lat)
          lat = []; windowStart = performance.now()
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker))
    report(`http c=${CONC} total`, done, performance.now() - t0)
    agent.destroy()
  }

  if (mode === 'spool') {
    const dir = path.join(work, 'spool')
    fs.mkdirSync(dir, { recursive: true })
    let n = 0
    for (let i = 0; i < CYCLES; i++) {
      for (const ev of cycleOf(i)) {
        if (ev.agentType !== 'shell' && ev.agentType !== 'agent') continue // hooks spool; mitmproxy does not use this dir
        fs.writeFileSync(path.join(dir, `${Date.now()}-${String(n).padStart(8, '0')}.json`),
          JSON.stringify({ agent_type: ev.agentType, data: ev.data, _identity: { engagementId: ENG, operatorId: op.id } }))
        n++
      }
    }
    const t0 = performance.now()
    const r = replaySpoolDirectory(dir, { engagementId: ENG, operatorId: op.id }, ({ agentType, data, engagementId, operatorId }) => {
      const result = ingest({ agentType, data, engagementId, operatorId, envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } } })
      return result.event ? true : result.skipped !== 'paused'
    })
    const ms = performance.now() - t0
    console.log(JSON.stringify({ label: 'spool replay (synchronous, main thread)', files: n, ...r, ms: Math.round(ms), filesPerSec: Math.round(n / ms * 1000), rssMiB: +mb(process.memoryUsage().rss) }))
  }

  if (mode === 'stages') {
    const evs: WorkEvent[] = []
    for (let i = 0; i < CYCLES; i++) evs.push(...cycleOf(i))
    const bodies = evs.map((ev) => JSON.stringify({ agent_type: ev.agentType, data: ev.data }))
    const time = (label: string, fn: (i: number) => void): void => {
      const t0 = performance.now()
      for (let i = 0; i < evs.length; i++) fn(i)
      const ms = performance.now() - t0
      console.log(JSON.stringify({ stage: label, n: evs.length, totalMs: +ms.toFixed(1), usPerEvent: +((ms / evs.length) * 1000).toFixed(1) }))
    }
    time('JSON.parse(request body)', (i) => { JSON.parse(bodies[i]) })
    time('JSON.stringify(data) for the data column', (i) => { JSON.stringify(evs[i].data) })
    time('canonicalStringify(event)', (i) => { canonicalStringify({ id: 'x', data: evs[i].data, prevHash: 'p' }) })
    time('canonicalStringify + sha256', (i) => {
      crypto.createHash('sha256').update(canonicalStringify({ id: 'x', data: evs[i].data, prevHash: 'p' })).digest('hex')
    })
    const canon = evs.map((ev) => canonicalStringify({ id: 'x', data: ev.data, prevHash: 'p' }))
    time('signEvent (Ed25519)', (i) => { signEvent(canon[i], op.id) })
    const db = getDB()
    db.exec('CREATE TABLE IF NOT EXISTS perf_probe (id TEXT PRIMARY KEY, data TEXT)')
    time('db.prepare(INSERT) each call + run', (i) => {
      db.prepare('INSERT INTO perf_probe (id, data) VALUES (?, ?)').run(`a${i}`, bodies[i])
    })
    const stmt = db.prepare('INSERT INTO perf_probe (id, data) VALUES (?, ?)')
    time('cached prepared INSERT + run', (i) => { stmt.run(`b${i}`, bodies[i]) })
    time('db.prepare(INSERT) only', () => { db.prepare(`INSERT INTO events_logged (id, timestamp, engagement_id, session_id, operator_id, agent_type, subtype, hostname, source_ip, target_id, data, created_at, raw_ref, mapper, schema_version, ts_source, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) })
    const many = db.transaction((from: number, to: number) => { for (let i = from; i < to; i++) stmt.run(`c${i}`, bodies[i]) })
    const t0 = performance.now()
    for (let i = 0; i < evs.length; i += 100) many(i, Math.min(evs.length, i + 100))
    const ms = performance.now() - t0
    console.log(JSON.stringify({ stage: 'cached INSERT, 100 rows per transaction', n: evs.length, totalMs: +ms.toFixed(1), usPerEvent: +((ms / evs.length) * 1000).toFixed(1) }))
    time('dedup window SELECT (20 rows) + JSON.parse each', () => {
      const rows = db.prepare(`SELECT id, agent_type, data FROM events WHERE agent_type IN ('shell','agent') AND timestamp >= ? ORDER BY timestamp DESC LIMIT 20`).all(0) as Array<{ data: string }>
      for (const r of rows) JSON.parse(r.data)
    })
  }

  console.error(`[bench] scope dispatches ${dispatches}`)
  api.stopApiServer()
}

main().catch((e) => { console.error(e); process.exit(1) })
