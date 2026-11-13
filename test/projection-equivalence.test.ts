import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { requires } from './helpers/requires'

// Spec 074 T013 — "stepwise equals rebuilt", for every projection (plan.md
// 「閘門」: 增量 == 重建). A projection is derived data: whatever the sequence
// of writes, a store that was advanced step by step must hold exactly what a
// store built from scratch over the same rows holds. This file is the skeleton
// and the first group: the one projection that exists today, the per-
// connection TEMP Activity projection in `src/core/db/activity-queries.ts`
// (`activity_groups_v1`). Phase 4 adds a group per new projection to
// PROJECTION_GROUPS below, and `test/projection-registry.test.ts` (later) says
// that every registered projection has one.
//
// The script is generated from a seed, so a failure names the seed and replays
// exactly. Steps: insert rows of both tiers (several in one millisecond,
// timestamps out of rowid order), read a page (which advances the projection),
// logged retention (the oldest logged rows deleted), the logged row with the
// highest rowid deleted and a new row inserted (SQLite hands the freed rowid
// out again), and a read that fails midway (a SQL function throws).
//
// "Slice interrupted" in the task text has no counterpart today: the Activity
// projection catches up in one statement per tier, inside the read's
// transaction, with no budget to run out of. The failing read above is the
// nearest thing it has — an interruption between the two tiers — and it is
// part of every script. When Phase 4's runner introduces slices the group for
// `activity` gains the real step.
//
// Nothing here depends on the clock, locale or time zone: timestamps are
// small integers, ids are counters, the generator is a seeded PRNG.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let getReadonlyDB: typeof import('../src/core/db/index').getReadonlyDB
let queryActivityPage: typeof import('../src/core/db/activity-queries').queryActivityPage
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let parseQuery: typeof import('../src/core/query/contract').parseQuery

let available = false
// Makes the next call of the named SQL function throw, once. It is installed
// before any connection registers its functions, because better-sqlite3 keeps
// the function it was given.
const failNext = new Set<string>()
let interrupted = 0
const realFunction = Database.prototype.function
if (requires('better-sqlite3').ok) {
  Database.prototype.function = function (this: Database.Database, name: string, ...rest: unknown[]) {
    const impl = rest[rest.length - 1] as (...a: unknown[]) => unknown
    const wrapped = (...a: unknown[]): unknown => {
      if (failNext.delete(name)) throw new Error(`injected failure in ${name}`)
      return impl(...a)
    }
    Object.defineProperty(wrapped, 'length', { value: impl.length })
    rest[rest.length - 1] = wrapped
    return (realFunction as (...x: unknown[]) => unknown).call(this, name, ...rest)
  } as typeof Database.prototype.function
  ;({ initDB, closeDB, getDB, getReadonlyDB } = await import('../src/core/db/index'))
  ;({ queryActivityPage } = await import('../src/core/db/activity-queries'))
  ;({ closeHttpBodyIndex } = await import('../src/core/http-body-index'))
  ;({ parseQuery } = await import('../src/core/query/contract'))
  available = true
}

/** mulberry32: a 32-bit seeded generator, the same on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Step = 'insert' | 'read' | 'retain' | 'dropMax' | 'failedRead'

function runScript(seed: number, steps: number): { log: string[]; stepwise: unknown[]; rebuilt: unknown[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-projeq-'))
  initDB(dir)
  try { return runScriptIn(dir, seed, steps) }
  finally { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) }
}

function runScriptIn(dir: string, seed: number, steps: number): { log: string[]; stepwise: unknown[]; rebuilt: unknown[] } {
  const rand = prng(seed), int = (n: number): number => Math.floor(rand() * n)
  const log: string[] = []
  const parsed = parseQuery('')
  if (!parsed.ok) throw new Error('fixture query')
  const read = (): void => { queryActivityPage({ projectId: 'eng', parsed: parsed.parsed, limit: 5 }) }
  let id = 0
  const insert = (): void => {
    const tier = rand() < 0.5 ? 'events' : 'events_logged'
    const ts = 1000 + int(6) // few distinct values: many rows share a millisecond
    const n = id++
    const pick = int(6)
    const data: Record<string, unknown> =
      pick === 0 ? { subtype: 'command_start', terminalId: 't1', command_id: `c${int(5)}`, command: 'id' }
        : pick === 1 ? { subtype: 'command_end', terminalId: 't1', command_id: `c${int(5)}`, command: 'id', exit_code: int(2) }
          : pick === 2 ? { subtype: 'http_request_start', flow_id: `f${int(5)}` }
            : pick === 3 ? { subtype: 'http_response', flow_id: `f${int(5)}`, status: 200 }
              : pick === 4 ? { subtype: 'tool_call', agent: 'claude-code', session_id: 'conv', tool_use_id: `u${int(4)}` }
                : { subtype: 'session_start', terminalId: 't1' } // housekeeping
    const type = pick <= 1 || pick === 5 ? 'shell' : pick <= 3 ? 'scanner' : 'agent'
    const cols = 'id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at'
    const row = [`r${n}`, ts, 'eng', 'binding', 'operator', type, String(data.subtype), 'host', null, null, JSON.stringify(data), ts]
    if (tier === 'events') getDB().prepare(`INSERT INTO events (${cols},hash,prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'fixture-hash',NULL)`).run(...row)
    else getDB().prepare(`INSERT INTO events_logged (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...row)
  }
  const kinds: Step[] = ['insert', 'insert', 'insert', 'read', 'read', 'retain', 'dropMax', 'failedRead']
  for (let i = 0; i < steps; i++) {
    const step = i < 4 ? 'insert' : kinds[int(kinds.length)]
    log.push(step)
    if (step === 'insert') { for (let k = 0, n = 1 + int(6); k < n; k++) insert() }
    else if (step === 'read') read()
    else if (step === 'retain') getDB().prepare('DELETE FROM events_logged WHERE rowid IN (SELECT rowid FROM events_logged ORDER BY rowid LIMIT ?)').run(1 + int(3))
    else if (step === 'dropMax') { getDB().prepare('DELETE FROM events_logged WHERE rowid = (SELECT MAX(rowid) FROM events_logged)').run(); insert() }
    else {
      insert(); insert()
      failNext.add(rand() < 0.5 ? 'redlog_activity_class_v1' : 'redlog_activity_digest_v1')
      try { read() } catch { interrupted++ /* the read is cut short inside the catch-up */ }
      failNext.clear()
    }
  }
  read()
  const groups = (): unknown[] => getReadonlyDB().prepare('SELECT * FROM temp.activity_groups_v1 ORDER BY engagement_id, ak').all()
  const stepwise = groups()
  // A fresh connection has no projection: this read builds it in one go.
  closeHttpBodyIndex(); closeDB()
  initDB(dir)
  read()
  return { log, stepwise, rebuilt: groups() }
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]

/** One entry per projection. `activity` is the only one today. */
const PROJECTION_GROUPS: Array<{ name: string; table: string; seeds: readonly number[]; steps: number }> = [
  { name: 'activity (TEMP, per connection)', table: 'activity_groups_v1', seeds: SEEDS, steps: 40 }
]

const describeDB = available ? describe : describe.skip
describeDB('a projection advanced step by step equals one built from scratch', () => {
  for (const group of PROJECTION_GROUPS) {
    describe(group.name, () => {
      for (const seed of group.seeds) {
        it(`seed ${seed}: ${group.table}`, () => {
          const { log, stepwise, rebuilt } = runScript(seed, group.steps)
          expect(stepwise.length, 'the script produced groups').toBeGreaterThan(0)
          expect(rebuilt, `seed ${seed}, script: ${log.join(' ')}`).toEqual(stepwise)
        })
      }
    })
  }

  it('the script reaches every step it claims to (so the groups above are not trivially equal)', () => {
    const seen = new Set<string>()
    for (const seed of SEEDS) for (const s of runScript(seed, 40).log) seen.add(s)
    expect([...seen].sort()).toEqual(['dropMax', 'failedRead', 'insert', 'read', 'retain'])
    expect(interrupted, 'at least one injected failure really interrupted a read').toBeGreaterThan(0)
  })
})
