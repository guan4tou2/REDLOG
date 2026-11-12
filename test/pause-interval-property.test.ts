// Spec 071 T015 (US2, FR-082–084 as revised 2026-11-13): the pause property,
// the forerunner of T022.
//
// Random pause intervals × random observation times × random door × random
// arrival time. The rule:
//   - a live door (API, in-process) is judged by receipt: refused while
//     recording is paused, written otherwise — whatever time the producer
//     claims, usable or not;
//   - the spool drain does not run while paused; after the pause, a file is
//     refused only if its usable source time lies inside a recorded pause, and
//     written otherwise (no source time, or a rejected one, counts as none);
//   - a marker is written whenever it arrives (FR-084).
// For every world:
//   1. no row other than a marker was RECEIVED during a pause (created_at);
//   2. no spooled row's usable source time lies inside a recorded pause;
//   3. every item is written exactly as the rule says, exactly once.
//
// Seeded and deterministic: the clock is faked, every choice comes from one
// PRNG. WORLDS × ITEMS cases; the full 10 000 is T022.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ingestMod: typeof import('../src/core/ingest')
let busMod: typeof import('../src/core/event-bus')
let drainMod: typeof import('../src/core/spool-drain')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ingestMod = await import('../src/core/ingest')
  busMod = await import('../src/core/event-bus')
  drainMod = await import('../src/core/spool-drain')
}

const SEED = 0x071_0215
const WORLDS = 25
const ITEMS = 160
const SPAN = 3600_000
const ORIGIN = Date.UTC(2026, 10, 1, 8, 0, 0)
const DAY = 24 * 3600_000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Door = 'api' | 'api-bad-time' | 'in-process' | 'spool' | 'spool-no-time' | 'spool-bad-time' | 'marker'
const DOORS: Door[] = ['api', 'api-bad-time', 'in-process', 'spool', 'spool-no-time', 'spool-bad-time', 'marker']

interface Item { n: number; door: Door; observed: number; arrival: number }
type Step = { at: number; kind: 'pause' | 'resume' } | { at: number; kind: 'item'; item: Item }

const inside = (t: number, pauses: Array<[number, number]>): boolean => pauses.some(([a, b]) => t >= a && t < b)

sqlite.describe(`the pause property (${WORLDS * ITEMS} seeded cases)`, () => {
  let root = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  const failures: string[] = []
  let cases = 0

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pause-prop-'))
    process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
    const rand = mulberry32(SEED)
    for (let w = 0; w < WORLDS; w++) {
      // A world a day after the last: the clock never runs backwards.
      const BASE = ORIGIN + w * DAY
      const eng = `eng-prop-${w}`
      const id = { engagementId: eng, operatorId: `op-prop-${w}` }
      const spool = path.join(root, `spool-${w}`)
      fs.mkdirSync(spool)
      vi.useFakeTimers({ now: BASE, toFake: ['Date'] })
      db.initDB(path.join(root, `p-${w}`))
      db.bindDBEngagement(eng)
      ingestMod._resetIngest()
      ops.createOperator({ id: id.operatorId, name: 'P', token: ops.generateToken(), isPrimary: true })

      // 1–4 pauses; the last may still be in effect at the end of the world.
      const bounds = Array.from({ length: 2 * (1 + Math.floor(rand() * 4)) }, () => BASE + 1000 + Math.floor(rand() * SPAN)).sort((a, b) => a - b)
      const openAtEnd = rand() < 0.3
      const pauses: Array<[number, number]> = []
      for (let i = 0; i < bounds.length; i += 2) pauses.push([bounds[i], openAtEnd && i === bounds.length - 2 ? Infinity : bounds[i + 1]])

      const items: Item[] = Array.from({ length: ITEMS }, (_, n) => {
        const observed = BASE + 1000 + Math.floor(rand() * SPAN)
        const arrival = observed + Math.floor(rand() * rand() * 30 * 60_000)
        return { n, door: DOORS[Math.floor(rand() * DOORS.length)], observed, arrival }
      })
      const steps: Step[] = []
      for (const [a, b] of pauses) {
        steps.push({ at: a, kind: 'pause' })
        if (Number.isFinite(b)) steps.push({ at: b, kind: 'resume' })
      }
      for (const item of items) steps.push({ at: item.arrival, kind: 'item', item })
      steps.sort((x, y) => x.at - y.at || (x.kind === 'item' ? 1 : 0) - (y.kind === 'item' ? 1 : 0))

      const command = (item: Item): string => `prop-${w}-${item.n}`
      const pausedAtArrival = new Map<number, boolean>()
      for (const step of steps) {
        vi.setSystemTime(step.at)
        if (step.kind === 'pause') {
          busMod.eventBus.pause('api')
          events.insertEvent('system', { subtype: 'recording_paused', source: 'api' }, id)
          continue
        }
        if (step.kind === 'resume') {
          busMod.eventBus.resume('api')
          events.insertEvent('system', { subtype: 'recording_resumed', source: 'api' }, id)
          continue
        }
        const { item } = step
        pausedAtArrival.set(item.n, busMod.eventBus.paused)
        const data = { subtype: 'command_start', command: `true ${command(item)}`, terminalId: `t-${w}-${item.n}`, pid: 10_000 + item.n }
        const badTime = Math.floor(item.observed / 1000)
        switch (item.door) {
          case 'api':
          case 'api-bad-time':
            ingestMod.ingest({ agentType: 'shell', data: { ...data, source_timestamp: item.door === 'api' ? item.observed : badTime }, ...id, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
            break
          case 'in-process':
            ingestMod.ingestEvent('shell', { ...data, source_timestamp: item.observed }, id)
            break
          case 'marker':
            ingestMod.ingestEvent('marker', { subtype: 'note', title: command(item), source_timestamp: item.observed }, id)
            break
          default: {
            const body = item.door === 'spool' ? { ...data, source_timestamp: item.observed }
              : item.door === 'spool-bad-time' ? { ...data, source_timestamp: badTime } : data
            fs.writeFileSync(path.join(spool, `${String(item.arrival).padStart(16, '0')}-${item.n}.json`), JSON.stringify({ agent_type: 'shell', data: body, _identity: id }))
            drainMod.drainSpoolOnce(spool, id)
          }
        }
      }
      // The world ends: whatever pause is open ends, and the spool drains once
      // more — what waited out a pause is written now.
      const end = BASE + SPAN + 31 * 60_000
      vi.setSystemTime(end)
      if (busMod.eventBus.paused) {
        busMod.eventBus.resume('api')
        events.insertEvent('system', { subtype: 'recording_resumed', source: 'api' }, id)
      }
      drainMod.drainSpoolOnce(spool, id)
      const closed = pauses.map(([a, b]): [number, number] => [a, Number.isFinite(b) ? b : end])

      const rows = (db.getDB().prepare(`SELECT agent_type, created_at, data FROM events WHERE agent_type IN ('shell','marker')
        UNION ALL SELECT agent_type, created_at, data FROM events_logged WHERE agent_type IN ('shell','marker')`).all() as Array<{ agent_type: string; created_at: number; data: string }>)
        .map((r) => ({ type: r.agent_type, createdAt: r.created_at, data: JSON.parse(r.data) as Record<string, unknown> }))
      const written = new Map<string, number>()
      for (const r of rows) {
        const key = r.type === 'marker' ? String(r.data.title) : String(r.data.command).replace(/^true /, '')
        written.set(key, (written.get(key) ?? 0) + 1)
        if (r.type === 'shell' && inside(r.createdAt, closed)) failures.push(`world ${w}: shell row ${key} received at ${r.createdAt - BASE}, inside a pause`)
        if (r.type === 'shell' && r.data.recovered_from_spool === true && typeof r.data.source_timestamp === 'number'
          && r.data.source_timestamp > 1.4e12 && inside(r.data.source_timestamp, closed)) {
          failures.push(`world ${w}: spooled row ${key} observed at ${r.data.source_timestamp - BASE}, inside a recorded pause`)
        }
      }
      for (const item of items) {
        cases++
        const live = item.door === 'api' || item.door === 'api-bad-time' || item.door === 'in-process'
        const expected = item.door === 'marker' ? 1
          : live ? (pausedAtArrival.get(item.n) ? 0 : 1)
          : item.door === 'spool' ? (inside(item.observed, closed) ? 0 : 1)
          : 1
        const got = written.get(command(item)) ?? 0
        if (got !== expected) {
          failures.push(`world ${w} item ${item.n} via ${item.door}: observed ${item.observed - BASE}, arrived ${item.arrival - BASE}, pauses ${JSON.stringify(closed.map(([a, b]) => [a - BASE, b - BASE]))}: ${got} row(s), expected ${expected}`)
        }
      }
      if (fs.readdirSync(spool).some((n) => n.endsWith('.json'))) failures.push(`world ${w}: spool files left after the last drain`)
      db.closeDB()
      vi.useRealTimers()
    }
  }, 120_000)

  afterAll(() => {
    vi.useRealTimers()
    if (busMod?.eventBus.paused) busMod.eventBus.resume('api')
    fs.rmSync(root, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  sqlite.it('ran every case', () => {
    expect(cases).toBe(WORLDS * ITEMS)
  })

  sqlite.it('nothing received during a pause; no spooled row observed in a recorded pause; each item as the rule says', () => {
    expect(failures.slice(0, 10), `${failures.length} violation(s)`).toEqual([])
  })
})
