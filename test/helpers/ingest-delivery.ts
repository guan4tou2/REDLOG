// Deliver the same items into a project by each way a row can arrive, and read
// back what was stored in a form two deliveries can be compared in. For the
// equivalence tests of Spec 071: restart (T032, SC-003) and door (T036,
// FR-093).
//
// Each runtime is a fresh module graph (vi.resetModules), so "restart" is what
// a process restart is: every module-level map — the causal links, ingest's
// per-terminal state, the chain head cache — starts empty, and the database
// is opened again from disk.
//
// The API door is the real POST /api/events handler, called with
// `http.createServer` intercepted (as test/api-route-guards.test.ts does), so
// no port is bound. The handoff door is the real spool drain. The in-process
// door is ingest() as RedLog's own producers call it.

import http from 'node:http'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { expect, vi } from 'vitest'

export const ENG = 'eng-equiv'
export const OP = 'op-equiv'

export interface Item {
  agent_type: string
  /** The body's own target, as mitmproxy-addon.py and pcap-agent.py send it. */
  target_id?: string
  data: Record<string, unknown>
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let handler: Handler | null = null
let intercepted = false

/** Route every http.createServer in this test file to an in-memory handler. */
export function interceptHttp(): void {
  if (intercepted) return
  intercepted = true
  vi.spyOn(http, 'createServer').mockImplementation(((h: Handler) => {
    handler = h
    return { listen: (_p: number, _h: string, cb: () => void) => { cb() }, address: () => ({ port: 6662 }), on: () => {}, close: () => {} }
  }) as never)
}

export interface Runtime {
  /** POST /api/events with the project's token: door legacy-api. */
  api(item: Item): Promise<void>
  /** ingest() as an in-process producer calls it: door in-process. */
  inProcess(item: Item): void
  /** Spool `items` as the hooks do and drain them as main does: door legacy-handoff. */
  spool(items: Item[], dir: string): void
  close(): Promise<void>
}

/** Open (or reopen) the project in `dir` in a fresh module graph. */
export async function openRuntime(dir: string): Promise<Runtime> {
  vi.resetModules()
  const db = await import('../../src/core/db/index')
  const ops = await import('../../src/core/db/operators')
  const api = await import('../../src/core/api-server')
  const ingest = await import('../../src/core/ingest')
  const drain = await import('./spool-drain-as-main')
  const extractors = await import('../../src/core/target-extractor')
  // The bundled tool→target pack, as the plugin host registers it at startup
  // (helpers/builtin-extractors.ts does the same for the static module graph).
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'builtin-tools', 'plugin.json'), 'utf8')) as
    { contributes?: { targetExtractors?: Array<{ cmd: string; extract?: string; flags?: string; strategy?: string; param?: string }> } }
  extractors.registerTargetExtractors('builtin-tools', pack.contributes?.targetExtractors ?? [], 'bundled')
  db.initDB(dir)
  db.bindDBEngagement(ENG)
  ops.ensurePrimaryOperator(OP, 'Equiv', ops.generateToken())
  api.configureApi({ engagementId: ENG, operatorId: OP, operatorName: 'Equiv' })
  await api.startApiServer(0)
  api.onApiProjectOpen()
  const token = api.getApiToken()
  return {
    async api(item) {
      const req = Readable.from([Buffer.from(JSON.stringify(item))]) as unknown as http.IncomingMessage
      Object.assign(req, { method: 'POST', url: '/api/events', socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:6662', authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
      const status = await new Promise<number>((resolve) => {
        let s = 200
        const res = { headersSent: false, setHeader: () => {},
          writeHead(code: number) { s = code; this.headersSent = true; return this },
          end() { resolve(s) } } as unknown as http.ServerResponse
        handler!(req, res)
      })
      expect(status, JSON.stringify(item)).toBe(201)
    },
    inProcess(item) {
      const r = ingest.ingest({ agentType: item.agent_type, data: item.data, engagementId: ENG, operatorId: OP, ...(item.target_id ? { targetId: item.target_id } : {}) })
      expect(r.event, JSON.stringify(item)).not.toBeNull()
    },
    spool(items, spoolDir) {
      fs.mkdirSync(spoolDir, { recursive: true })
      items.forEach((item, i) => fs.writeFileSync(path.join(spoolDir, `${String(i).padStart(4, '0')}.json`),
        JSON.stringify({ ...item, _identity: { engagementId: ENG, operatorId: OP } })))
      const run = drain.drainSpoolAsMain(spoolDir, { engagementId: ENG, operatorId: OP })
      expect(run?.replayed, JSON.stringify(run)).toBe(items.length)
    },
    async close() {
      api.stopApiServer()
      ;(await import('../../src/core/http-body-index')).closeHttpBodyIndex()
      db.closeDB()
    }
  }
}

export interface StoredRow {
  table: 'events' | 'events_logged'
  row: Record<string, unknown>
  data: Record<string, unknown>
}

/** Every stored row of both tiers, each tier in the order it was written. */
export async function storedRows(dir: string): Promise<StoredRow[]> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(path.join(dir, 'timeline.db'), { readonly: true })
  try {
    const out: StoredRow[] = []
    for (const table of ['events', 'events_logged'] as const) {
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>) {
        out.push({ table, row, data: JSON.parse(String(row.data)) as Record<string, unknown> })
      }
    }
    return out
  } finally { db.close() }
}

/** A row's position in its delivery, which is what a `_causes` id stands for
 *  across two deliveries (the ids themselves are minted per row). */
export function causesByPosition(rows: StoredRow[]): (r: StoredRow) => string[] | undefined {
  const at = new Map(rows.map((r, i) => [String(r.row.id), `#${i}`]))
  return (r) => Array.isArray(r.data._causes) ? (r.data._causes as string[]).map((id) => at.get(id) ?? `outside:${id}`) : undefined
}

/** Flatten an object to `path → JSON value`, for naming what differs. */
export function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { [prefix]: JSON.stringify(value) }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k))
  return out
}

/** The paths at which `a` and `b` differ. */
export function differences(a: unknown, b: unknown): string[] {
  const fa = flatten(a), fb = flatten(b)
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]).sort()
}
