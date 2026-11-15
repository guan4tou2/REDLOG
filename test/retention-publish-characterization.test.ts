import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requires } from './helpers/requires'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Spec 071 T037. The five retention writes go through the one door; this file
// is the whole before/after evidence. It runs the sweeps as production calls
// them (real DB, real files) and pins, per sweep: the row written (kind,
// subtype, target, data, `_causes`, `_ingest` without its event_id), how many
// times that row reaches a subscriber of the event bus, and what the sweep
// returns. It must pass on the hand-written `insertEvent` + `eventBus.publish`
// pair and on the door unchanged.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let bindDBEngagement: typeof import('../src/core/db/index').bindDBEngagement
let getDB: typeof import('../src/core/db/index').getDB
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let castIndex: typeof import('../src/core/cast-index')
let events: typeof import('../src/core/db/events')
let retention: typeof import('../src/core/retention')
let bus: typeof import('../src/core/event-bus').eventBus
let bookmarks: typeof import('../src/core/db/bookmarks')

let dbAvailable = false
if (requires('better-sqlite3').ok) {
  const d = await import('../src/core/db/index')
  initDB = d.initDB; closeDB = d.closeDB; bindDBEngagement = d.bindDBEngagement; getDB = d.getDB
  closeHttpBodyIndex = (await import('../src/core/http-body-index')).closeHttpBodyIndex
  castIndex = await import('../src/core/cast-index')
  events = await import('../src/core/db/events')
  retention = await import('../src/core/retention')
  bus = (await import('../src/core/event-bus')).eventBus
  bookmarks = await import('../src/core/db/bookmarks')
  dbAvailable = true
}

const describeDB = dbAvailable ? describe : describe.skip
const DAY = 86_400_000
const OPTS = { engagementId: 'eng', operatorId: 'op' }
let dir: string
let delivered: Array<{ id: string; agentType: string }> = []
const listener = (e: { id: string; agentType: string }): void => { delivered.push({ id: e.id, agentType: e.agentType }) }

/** The bus fans out in a microtask; wait for it. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const age = (p: string, days: number): void => { const t = new Date(Date.now() - days * DAY); fs.utimesSync(p, t, t) }
const seedFile = (sub: string, name: string, days: number, size = 1): string => {
  const d = path.join(dir, sub)
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, name)
  fs.writeFileSync(f, Buffer.alloc(size, 1))
  age(f, days)
  return f
}

/** What a row is, without the parts that are different on every run. */
function shape(subtype: string): Array<Record<string, unknown>> {
  return events.queryEvents({ limit: 500 })
    .filter((e) => e.agentType === 'system' && e.data?.subtype === subtype)
    .map((e) => {
      const data = JSON.parse(JSON.stringify(e.data).split(dir).join('<dir>')) as Record<string, unknown>
      const stamp = { ...(data._ingest as Record<string, unknown>) }
      delete stamp.event_id
      return { agentType: e.agentType, targetId: e.targetId ?? null, data: { ...data, _ingest: stamp } }
    })
}
const idsOf = (subtype: string): string[] =>
  events.queryEvents({ limit: 500 }).filter((e) => e.data?.subtype === subtype).map((e) => e.id)
const timesDelivered = (id: string): number => delivered.filter((d) => d.id === id).length

describeDB('retention writes — rows and delivery, as production calls them', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ret-char-'))
    initDB(dir); bindDBEngagement('eng')
    if (bus.paused) bus.resume()
    delivered = []
    bus.on('event', listener)
    delete process.env.REDLOG_LOGGED_RETENTION_DAYS
  })
  afterEach(() => {
    bus.off('event', listener)
    if (bus.paused) bus.resume()
    castIndex.closeCastIndex()
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('sweepDir: one row per deleted file, with the cause chained, each delivered once', async () => {
    const cast = seedFile('casts', 'a.cast', 40, 7)
    const shot = seedFile('screenshots', 'a.jpg', 40, 7)
    seedFile('agent-transcripts', 'a.jsonl', 40, 7)
    seedFile('http-bodies', 'a.body', 40, 7)
    const castCause = events.insertEvent('shell', { subtype: 'session_end', castPath: cast }, OPTS)!
    const shotCause = events.insertEvent('screenshot', { filePath: shot, filename: 'a.jpg' }, OPTS)!
    delivered = []

    const r = retention.sweepRetention({ retention: {
      casts: { keepDays: 30 }, screenshots: { keepDays: 30 },
      agentTranscripts: { keepDays: 30 }, httpBodies: { keepDays: 30 }
    } }, OPTS)
    await flush()

    expect(r).toEqual({ cast: 1, screenshots: 1, agentTranscripts: 1, httpBodies: 1 })
    const out: Record<string, unknown> = {}
    for (const s of ['cast_pruned', 'screenshot_pruned', 'agent_transcript_pruned', 'http_body_pruned']) {
      out[s] = shape(s)
      const ids = idsOf(s)
      expect(ids).toHaveLength(1)
      expect(timesDelivered(ids[0]), `${s} delivered`).toBe(1)
    }
    expect(delivered.filter((d) => d.agentType === 'system')).toHaveLength(4)
    // The cause ids are random per run; name them.
    const named = JSON.parse(JSON.stringify(out).split(castCause.id).join('<castCause>').split(shotCause.id).join('<shotCause>'))
    expect(named).toMatchInlineSnapshot(`
      {
        "agent_transcript_pruned": [
          {
            "agentType": "system",
            "data": {
              "_ingest": {
                "auth": "in-process",
                "credential": null,
                "door": "in-process",
                "producer": "in-process",
                "target_via": "none",
                "v": 1,
              },
              "ageDays": 40,
              "bytes": 7,
              "description": "pruned by retention policy (30d)",
              "path": "<dir>/agent-transcripts/a.jsonl",
              "subtype": "agent_transcript_pruned",
            },
            "targetId": null,
          },
        ],
        "cast_pruned": [
          {
            "agentType": "system",
            "data": {
              "_causes": [
                "<castCause>",
              ],
              "_ingest": {
                "auth": "in-process",
                "credential": null,
                "door": "in-process",
                "producer": "in-process",
                "target_via": "none",
                "v": 1,
              },
              "ageDays": 40,
              "bytes": 7,
              "description": "pruned by retention policy (30d)",
              "path": "<dir>/casts/a.cast",
              "subtype": "cast_pruned",
            },
            "targetId": null,
          },
        ],
        "http_body_pruned": [
          {
            "agentType": "system",
            "data": {
              "_ingest": {
                "auth": "in-process",
                "credential": null,
                "door": "in-process",
                "producer": "in-process",
                "target_via": "none",
                "v": 1,
              },
              "ageDays": 40,
              "bytes": 7,
              "description": "pruned by retention policy (30d)",
              "path": "<dir>/http-bodies/a.body",
              "subtype": "http_body_pruned",
            },
            "targetId": null,
          },
        ],
        "screenshot_pruned": [
          {
            "agentType": "system",
            "data": {
              "_causes": [
                "<shotCause>",
              ],
              "_ingest": {
                "auth": "in-process",
                "credential": null,
                "door": "in-process",
                "producer": "in-process",
                "target_via": "none",
                "v": 1,
              },
              "ageDays": 40,
              "bytes": 7,
              "description": "pruned by retention policy (30d)",
              "path": "<dir>/screenshots/a.jpg",
              "subtype": "screenshot_pruned",
            },
            "targetId": null,
          },
        ],
      }
    `)
  })

  it('sweepDir while paused: the rows are still written, none is delivered', async () => {
    seedFile('casts', 'a.cast', 40); seedFile('screenshots', 'a.jpg', 40)
    delivered = []
    bus.pause('ui')
    const r = retention.sweepRetention({ retention: { casts: { keepDays: 30 }, screenshots: { keepDays: 30 } } }, OPTS)
    await flush()
    expect(r).toEqual({ cast: 1, screenshots: 1, agentTranscripts: 0, httpBodies: 0 })
    expect(shape('cast_pruned')).toHaveLength(1)
    expect(shape('screenshot_pruned')).toHaveLength(1)
    expect(delivered).toEqual([])
  })

  it('sweepLoggedTier: one summary row, delivered once; nothing at all while paused', async () => {
    const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'old.test' }, OPTS)!
    getDB().prepare('UPDATE events_logged SET created_at = ? WHERE id = ?').run(Date.now() - 40 * DAY, ev.id)
    delivered = []

    bus.pause('ui')
    expect(retention.sweepLoggedTier({ keepDays: 30 }, OPTS).deleted).toBe(0)
    bus.resume('ui')
    expect(shape('retention_pruned_logged')).toHaveLength(0)

    const r = retention.sweepLoggedTier({ keepDays: 30 }, OPTS)
    await flush()
    expect({ deleted: r.deleted, bytesFreed: r.bytesFreed > 0, oldest: r.oldestPruned !== null }).toEqual({ deleted: 1, bytesFreed: true, oldest: true })
    const [row] = shape('retention_pruned_logged') as Array<{ data: Record<string, unknown> }>
    for (const k of ['bytes_freed', 'oldest_pruned_at', 'newest_pruned_at', 'sweep_duration_ms']) delete row.data[k]
    expect(row).toMatchInlineSnapshot(`
      {
        "agentType": "system",
        "data": {
          "_ingest": {
            "auth": "in-process",
            "credential": null,
            "door": "in-process",
            "producer": "in-process",
            "target_via": "none",
            "v": 1,
          },
          "count": 1,
          "description": "retention: pruned 1 logged-tier row(s), freed ~0 MB (30d policy)",
          "keep_days": 30,
          "subtype": "retention_pruned_logged",
        },
        "targetId": null,
      }
    `)
    expect(timesDelivered(idsOf('retention_pruned_logged')[0])).toBe(1)
  })

  it('sweepBookmarks: one count-only row, delivered once; nothing at all while paused', async () => {
    const bm = bookmarks.createBookmark({ title: 'old' })
    getDB().prepare('UPDATE bookmarks SET created_at = ? WHERE id = ?').run(Date.now() - 40 * DAY, bm.id)

    bus.pause('ui')
    expect(retention.sweepBookmarks({ keepDays: 30 }, OPTS)).toBe(0)
    bus.resume('ui')
    expect(bookmarks.listBookmarks()).toHaveLength(1)
    delivered = []

    expect(retention.sweepBookmarks({ keepDays: 30 }, OPTS)).toBe(1)
    await flush()
    expect(shape('bookmarks_pruned')).toMatchInlineSnapshot(`
      [
        {
          "agentType": "system",
          "data": {
            "_ingest": {
              "auth": "in-process",
              "credential": null,
              "door": "in-process",
              "producer": "in-process",
              "target_via": "none",
              "v": 1,
            },
            "count": 1,
            "description": "Pruned 1 bookmark(s) older than 30d",
            "keep_days": 30,
            "subtype": "bookmarks_pruned",
          },
          "targetId": null,
        },
      ]
    `)
    expect(timesDelivered(idsOf('bookmarks_pruned')[0])).toBe(1)
  })

  it('sweepBodyStore: one summary row, delivered once; written but not delivered while paused', async () => {
    const bodies = path.join(dir, 'http-bodies'); fs.mkdirSync(bodies, { recursive: true })
    const mk = (n: string): void => { const f = path.join(bodies, n); fs.writeFileSync(f, Buffer.alloc(2000, 1)); age(f, 1) }
    mk('a.body'); mk('b.body')
    const cfg = { retention: { httpBodies: { maxBytes: 500 } } }

    bus.pause('ui'); delivered = []
    const paused = retention.sweepBodyStore(cfg, OPTS)
    await flush()
    expect(paused.evicted).toBe(2)
    expect(shape('body_evicted')).toHaveLength(1)
    expect(delivered).toEqual([])
    bus.resume('ui')

    mk('c.body'); mk('d.body'); delivered = []
    const r = retention.sweepBodyStore(cfg, OPTS)
    await flush()
    expect(r).toEqual({ evicted: 2, freedBytes: 4000, shortfallBytes: 0 })
    const rows = events.queryEvents({ limit: 50 }).filter((e) => e.data?.subtype === 'body_evicted')
    expect(rows).toHaveLength(2)
    expect(rows.map((e) => timesDelivered(e.id)).sort()).toEqual([0, 1])
    expect(shape('body_evicted')).toMatchInlineSnapshot(`
      [
        {
          "agentType": "system",
          "data": {
            "_ingest": {
              "auth": "in-process",
              "credential": null,
              "door": "in-process",
              "producer": "in-process",
              "target_via": "none",
              "v": 1,
            },
            "budget_bytes": 500,
            "count": 2,
            "description": "Evicted 2 body file(s) under disk pressure (freed 4000 bytes; in-scope bodies kept).",
            "freed_bytes": 4000,
            "shortfall_bytes": 0,
            "subtype": "body_evicted",
            "total_bytes": 4000,
          },
          "targetId": null,
        },
        {
          "agentType": "system",
          "data": {
            "_ingest": {
              "auth": "in-process",
              "credential": null,
              "door": "in-process",
              "producer": "in-process",
              "target_via": "none",
              "v": 1,
            },
            "budget_bytes": 500,
            "count": 2,
            "description": "Evicted 2 body file(s) under disk pressure (freed 4000 bytes; in-scope bodies kept).",
            "freed_bytes": 4000,
            "shortfall_bytes": 0,
            "subtype": "body_evicted",
            "total_bytes": 4000,
          },
          "targetId": null,
        },
      ]
    `)
  })

  it('sweepArtifactStore: one summary row per kind, delivered once; written but not delivered while paused', async () => {
    const mk = (sub: string, n: string): void => { seedFile(sub, n, 1, 2000) }
    mk('casts', 'a.cast'); mk('screenshots', 'a.jpg')
    const cfg = { retention: { casts: { maxBytes: 500 }, screenshots: { maxBytes: 500 } } }

    bus.pause('ui'); delivered = []
    expect(retention.sweepArtifactStore('cast', cfg, OPTS).evicted).toBe(1)
    await flush()
    expect(shape('cast_evicted')).toHaveLength(1)
    expect(delivered).toEqual([])
    bus.resume('ui')

    delivered = []
    mk('screenshots', 'b.jpg')
    const r = retention.sweepArtifactStore('screenshot', cfg, OPTS)
    await flush()
    expect(r.evicted).toBe(2)
    expect(shape('screenshot_evicted')).toMatchInlineSnapshot(`
      [
        {
          "agentType": "system",
          "data": {
            "_ingest": {
              "auth": "in-process",
              "credential": null,
              "door": "in-process",
              "producer": "in-process",
              "target_via": "none",
              "v": 1,
            },
            "budget_bytes": 500,
            "count": 2,
            "description": "Evicted 2 screenshot file(s) under disk pressure (freed 4000 bytes; in-scope screenshots kept).",
            "freed_bytes": 4000,
            "shortfall_bytes": 0,
            "subtype": "screenshot_evicted",
            "total_bytes": 4000,
          },
          "targetId": null,
        },
      ]
    `)
    expect(timesDelivered(idsOf('screenshot_evicted')[0])).toBe(1)
    expect(delivered.filter((d) => d.agentType === 'system')).toHaveLength(1)
  })
})
