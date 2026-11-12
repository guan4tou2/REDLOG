// Spec 071 T015 (US2, FR-082–084): the pause property, the forerunner of T022.
//
// Random pause intervals × random observation times × random door × random
// arrival time. For every world:
//   1. no shell row in either tier is timestamped inside a pause interval;
//   2. an item is written if and only if it was observed outside every pause —
//      observed before a pause it is written whenever it arrives, including
//      while a later pause is in effect; observed inside one it never is;
//   3. the exemptions are unchanged: a marker is written whenever observed.
//
// Doors: the API path (ingest with the api envelope), in-process
// (ingestEvent), the spool drain with a source time, the spool drain with no
// source time (judged by the file's mtime, held while a pause is in effect),
// and the API with a source time ingest rejects (judged by receipt time,
// FR-004 / the spec's edge cases).
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

type Door = 'api' | 'in-process' | 'spool' | 'spool-no-time' | 'api-bad-time' | 'marker'
const DOORS: Door[] = ['api', 'in-process', 'spool', 'spool-no-time', 'api-bad-time', 'marker']

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
      // A world a day after the last: the clock never runs backwards, as the
      // pause in this process (eventBus) is the machine's, not the project's.
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
      // An item the source observed during a pause is still offered: an old
      // hook, a spool written with the app down. It is the receiver that must
      // refuse it (FR-082).
      for (const item of items) steps.push({ at: item.arrival, kind: 'item', item })
      steps.sort((x, y) => x.at - y.at || (x.kind === 'item' ? 1 : 0) - (y.kind === 'item' ? 1 : 0))

      const command = (item: Item): string => `prop-${w}-${item.n}`
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
        const data = { subtype: 'command_start', command: `true ${command(item)}`, terminalId: `t-${w}-${item.n}`, pid: 10_000 + item.n }
        switch (item.door) {
          case 'api':
            ingestMod.ingest({ agentType: 'shell', data: { ...data, source_timestamp: item.observed }, ...id, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
            break
          case 'api-bad-time':
            ingestMod.ingest({ agentType: 'shell', data: { ...data, source_timestamp: Math.floor(item.observed / 1000) }, ...id, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
            break
          case 'in-process':
            ingestMod.ingestEvent('shell', { ...data, source_timestamp: item.observed }, id)
            break
          case 'marker':
            ingestMod.ingestEvent('marker', { subtype: 'note', title: command(item), source_timestamp: item.observed }, id)
            break
          case 'spool':
          case 'spool-no-time': {
            const file = path.join(spool, `${String(item.observed).padStart(16, '0')}-${item.n}.json`)
            fs.writeFileSync(file, JSON.stringify({ agent_type: 'shell', data: item.door === 'spool' ? { ...data, source_timestamp: item.observed } : data, _identity: id }))
            fs.utimesSync(file, item.observed / 1000, item.observed / 1000)
            drainMod.drainSpoolOnce(spool, id)
          }
        }
      }
      // The world ends: whatever pause is open ends, and the spool drains once
      // more — "whenever it arrives" includes after the pause it waited out.
      const end = BASE + SPAN + 31 * 60_000
      vi.setSystemTime(end)
      if (busMod.eventBus.paused) {
        busMod.eventBus.resume('api')
        events.insertEvent('system', { subtype: 'recording_resumed', source: 'api' }, id)
      }
      drainMod.drainSpoolOnce(spool, id)
      const closed = pauses.map(([a, b]): [number, number] => [a, Number.isFinite(b) ? b : end])

      // What landed, from both tiers.
      const rows = (db.getDB().prepare(`SELECT agent_type, timestamp, data FROM events WHERE agent_type IN ('shell','marker')
        UNION ALL SELECT agent_type, timestamp, data FROM events_logged WHERE agent_type IN ('shell','marker')`).all() as Array<{ agent_type: string; timestamp: number; data: string }>)
        .map((r) => ({ type: r.agent_type, timestamp: r.timestamp, data: JSON.parse(r.data) as Record<string, unknown> }))
      const written = new Map<string, number>()
      for (const r of rows) {
        const key = r.type === 'marker' ? String(r.data.title) : String(r.data.command).replace(/^true /, '')
        written.set(key, (written.get(key) ?? 0) + 1)
        if (r.type === 'shell' && inside(r.timestamp, closed)) failures.push(`world ${w}: shell row ${key} timestamped ${r.timestamp - BASE} inside a pause`)
      }
      for (const item of items) {
        cases++
        const judgedAt = item.door === 'api-bad-time' ? item.arrival : item.observed
        const expected = item.door === 'marker' ? 1 : inside(judgedAt, closed) ? 0 : 1
        const got = written.get(command(item)) ?? 0
        if (got !== expected) {
          failures.push(`world ${w} item ${item.n} via ${item.door}: observed ${item.observed - BASE}, arrived ${item.arrival - BASE}, pauses ${JSON.stringify(closed.map(([a, b]) => [a - BASE, b - BASE]))}: ${got} row(s), expected ${expected}`)
        }
      }
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

  sqlite.it('no row inside a pause; written iff observed outside every pause; markers always', () => {
    expect(failures.slice(0, 10), `${failures.length} violation(s)`).toEqual([])
  })
})
