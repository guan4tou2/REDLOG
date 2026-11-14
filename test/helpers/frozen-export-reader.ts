// A real `worker_threads` worker that opens the project the way the export
// worker does (src/main/services/export-worker.ts): `openReadonlyProjectDB`,
// then `BEGIN`, so its view of the source rows is frozen at that moment for as
// long as it lives. It then searches under the snapshot of that view, as
// export selection does. The source modules are loaded from src/ through jiti,
// so it is the same code the export worker bundles, not a copy of it.
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import type { ExportSnapshot } from '../../src/core/export-plan'

const ROOT = path.resolve(__dirname, '../..')

const SOURCE = `
const { parentPort } = require('node:worker_threads')
const { createJiti } = require(${JSON.stringify(path.join(ROOT, 'node_modules/jiti'))})
const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules/better-sqlite3'))})
const jiti = createJiti(${JSON.stringify(ROOT + '/')})
const load = file => jiti.import(${JSON.stringify(ROOT)} + '/src/core/' + file)
let m, snapshot, rows = 0
// Source rows the body index reads, counted as the main-thread tests count them.
const prepare = Database.prototype.prepare
Database.prototype.prepare = function (text) {
  const s = prepare.call(this, text)
  if (/^SELECT id,data,agent_type/.test(text)) {
    const iterate = s.iterate.bind(s), get = s.get.bind(s)
    s.iterate = function* (...a) { for (const r of iterate(...a)) { rows++; yield r } }
    s.get = (...a) => { const r = get(...a); if (r) rows++; return r }
  }
  return s
}
parentPort.on('message', async ({ id, op, arg }) => {
  try {
    let result
    if (op === 'open') {
      m = { db: await load('db/index.ts'), queries: await load('db/event-queries.ts'), idx: await load('http-body-index.ts'),
        snap: await load('db/dataset-snapshot.ts'), contract: await load('query/contract.ts') }
      // As export-worker.ts opens it.
      m.db.openReadonlyProjectDB(arg.dir, arg.engagementId)
      m.db.getDB().exec('BEGIN')
      snapshot = m.snap.readActivitySnapshot(m.db.getDB())
      result = { snapshot }
    } else if (op === 'search') {
      rows = 0
      const outcome = m.contract.parseQuery(arg.text)
      const page = m.queries.executeEventQuery({ parsed: outcome.parsed, filter: {}, snapshot, limit: 1000 })
      const body = page.bodyCoverage.sources.find(s => s.kind === 'body')
      result = { ids: page.items.map(e => e.id).sort(), rows, coverage: { status: body.status, indexed: body.indexed, missing: body.missing, pending: body.pending } }
    } else if (op === 'pages') {
      // Every page of one search, following the cursor, as export selection does.
      rows = 0
      const outcome = m.contract.parseQuery(arg.text)
      const ids = []
      let cursor = null
      try {
        do {
          const page = m.queries.executeEventQuery({ parsed: outcome.parsed, filter: {}, snapshot, cursor, limit: arg.limit })
          for (const e of page.items) ids.push(e.id)
          cursor = page.hasMore ? page.nextCursor : null
        } while (cursor)
        result = { ids: ids.sort(), rows }
      } catch (error) { result = { ids: ids.sort(), rows, error: String(error && error.message || error) } }
    } else if (op === 'call') {
      // A writer of the shared index, called from this read-only connection.
      m.idx[arg.name](...arg.args)
      result = null
    } else if (op === 'close') {
      m.db.getDB().exec('ROLLBACK'); m.idx.closeHttpBodyIndex(); m.db.closeDB()
    }
    parentPort.postMessage({ id, result })
  } catch (error) { parentPort.postMessage({ id, error: String(error && error.stack || error) }) }
})
`

export interface FrozenReader {
  snapshot: ExportSnapshot
  search(text: string): Promise<{ ids: string[]; rows: number; coverage: { status: string; indexed: number; missing: number; pending: number } }>
  /** Every page of one search under its snapshot, `limit` per page. */
  pages(text: string, limit: number): Promise<{ ids: string[]; rows: number; error?: string }>
  /** Call an exported function of http-body-index.ts in the worker. */
  call(name: string, ...args: unknown[]): Promise<void>
  close(): Promise<void>
}

export async function openFrozenReader(dir: string, engagementId: string): Promise<FrozenReader> {
  const worker = new Worker(SOURCE, { eval: true })
  let next = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  worker.on('message', ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(id)!
    pending.delete(id)
    if (error) p.reject(new Error(error)); else p.resolve(result)
  })
  worker.on('error', error => { for (const p of pending.values()) p.reject(error) })
  const call = <T>(op: string, arg?: unknown): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker.postMessage({ id, op, arg })
  })
  const { snapshot } = await call<{ snapshot: ExportSnapshot }>('open', { dir, engagementId })
  return {
    snapshot,
    search: text => call('search', { text }),
    pages: (text, limit) => call('pages', { text, limit }),
    call: (name, ...args) => call('call', { name, args }),
    close: async () => { try { await call('close') } finally { await worker.terminate() } },
  }
}
