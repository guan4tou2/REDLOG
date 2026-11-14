// Spec 071 SC-003, case by case: what memory says about a command and what its
// stored rows say must be the same answer, so live delivery and delivery with a
// restart anywhere in between write the same rows.
//
// A "restart" here is _resetIngest(): every map in ingest.ts and
// causes-resolver.ts emptied, the database left as it is — the same loss a
// process restart is for these maps (test/ingest-restart-equivalence.test.ts
// does the whole restart, a fresh module graph; this file needs hundreds of
// rows in one transaction, which that cannot give). The engagement's current
// target is set again after each, as main does when a project opens.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')
const db = await import('../src/core/db/index')
const ops = await import('../src/core/db/operators')
const ingestMod = await import('../src/core/ingest')
const bus = await import('../src/core/event-bus')
const bodyIndex = await import('../src/core/http-body-index')
// An HTTP row opens the body index beside the database; Windows refuses to
// delete a directory holding an open file, so both are closed before it goes.
const closeProject = (): void => { bodyIndex.closeHttpBodyIndex(); db.closeDB() }

const ENG = 'eng-links-eq'
const OP = 'op-links-eq'

type Step =
  | { shell: Record<string, unknown> }
  | { scanner: Record<string, unknown> }
  | { target: string | null }
  | { pause: boolean }
  /** Let this much time pass: past insertEvent's 2 s duplicate window, say. */
  | { wait: number }

interface Row { subtype: unknown; command_id: unknown; seq: unknown; target_id: unknown; unattributed: unknown; causes: string[] | undefined }

const start = (command_id: unknown, command: string, extra: Record<string, unknown> = {}): Step =>
  ({ shell: { subtype: 'command_start', command, terminalId: 't1', pid: 7, command_id, ...extra } })
const end = (command_id: unknown, command: string, extra: Record<string, unknown> = {}): Step =>
  ({ shell: { subtype: 'command_end', command, terminalId: 't1', pid: 7, command_id, exit_code: 0, ...extra } })
const chunk = (command_id: unknown, seq: number, extra: Record<string, unknown> = {}): Step =>
  ({ shell: { subtype: 'command_output', command_id, late: true, seq, stdout: `${String(command_id)} ${seq}\n`, final: false, ...extra } })

sqlite.describe('memory and stored rows agree (SC-003)', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-links-eq-'))
  })
  afterEach(() => {
    if (bus.eventBus.paused) bus.eventBus.resume()
    vi.useRealTimers()
    closeProject()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Deliver `steps` into a fresh project, restarting before each index in
   *  `restarts`; return each stored shell row and what each step answered. */
  function deliver(steps: Step[], restarts: number[] = []): { rows: Row[]; skipped: Array<string | undefined> } {
    closeProject()
    const d = fs.mkdtempSync(path.join(dir, 'run-'))
    db.initDB(d)
    db.bindDBEngagement(ENG)
    ops.ensurePrimaryOperator(OP, 'Eq', ops.generateToken())
    ingestMod._resetIngest()
    let target: string | null = null
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 15, 9) })
    const skipped: Array<string | undefined> = []
    db.getDB().transaction(() => {
      for (const [i, step] of steps.entries()) {
        if (restarts.includes(i)) { ingestMod._resetIngest(); ingestMod.configureIngest({ activeTarget: target }) }
        if ('target' in step) { target = step.target; ingestMod.configureIngest({ activeTarget: target }); continue }
        if ('pause' in step) { if (step.pause) bus.eventBus.pause(); else bus.eventBus.resume(); continue }
        if ('wait' in step) { vi.setSystemTime(Date.now() + step.wait); continue }
        const [agentType, data] = 'shell' in step ? ['shell', step.shell] : ['scanner', step.scanner]
        skipped.push(ingestMod.ingest({ agentType, data, engagementId: ENG, operatorId: OP }).skipped)
      }
    })()
    const stored = [
      ...db.getDB().prepare(`SELECT id, target_id, data FROM events WHERE agent_type = 'shell' ORDER BY rowid`).all(),
      ...db.getDB().prepare(`SELECT id, target_id, data FROM events_logged ORDER BY rowid`).all()
    ] as Array<{ id: string; target_id: string | null; data: string }>
    const at = new Map(stored.map((r, i) => [r.id, `#${i}`]))
    const rows = stored.map((r) => {
      const data = JSON.parse(r.data) as Record<string, unknown>
      return {
        subtype: data.subtype, command_id: data.command_id, seq: data.seq, target_id: r.target_id, unattributed: data.unattributed,
        causes: Array.isArray(data._causes) ? (data._causes as string[]).map((id) => at.get(id) ?? 'outside') : undefined
      }
    })
    return { rows, skipped }
  }

  /** Live, and restarted before each step in turn (paused stretches left
   *  alone: an app that restarts comes back recording). */
  function expectEquivalent(steps: Step[], positions?: number[]): ReturnType<typeof deliver> {
    const live = deliver(steps)
    let paused = false
    const all = positions ?? steps.map((step, i) => {
      const here = i > 0 && !paused ? i : -1
      if ('pause' in step) paused = step.pause
      return here
    }).filter((i) => i > 0)
    for (const i of all) expect(deliver(steps, [i]), `restarted before step ${i}`).toEqual(live)
    return live
  }

  const causesOf = (rows: Row[], subtype: string, command_id?: unknown) => rows.filter((r) => r.subtype === subtype && (command_id === undefined || r.command_id === command_id)).map((r) => r.causes)

  // Review item 2. Both late-output maps are bounded at 256; the target map
  // gains an entry at every command_start, the seen-chunks map only at a late
  // chunk, so 300 commands later only the target was gone, and live filed the
  // next chunk under the global target.
  it('a background command 300 commands back keeps its target, live as after a restart', () => {
    const steps: Step[] = [
      { target: 'A' },
      start('L', 'sleep 99 &'), end('L', 'sleep 99 &', { late_output: true }), chunk('L', 0),
      ...Array.from({ length: 300 }, (_, i) => [start(`x${i}`, `true ${i}`, { pid: 1000 + i }), end(`x${i}`, `true ${i}`, { pid: 1000 + i })]).flat(),
      { target: 'B' },
      chunk('L', 1)
    ]
    const live = expectEquivalent(steps, [steps.length - 1])
    const last = live.rows[live.rows.length - 1]
    expect([last.command_id, last.seq, last.target_id, last.causes]).toEqual(['L', 1, 'A', ['#0']])
  })

  // Review item 3: a row refused while paused was never recorded, so as far
  // as the record goes the command has not ended.
  describe('a row refused while paused changes nothing', () => {
    it('a command_end refused during a pause and sent again after: the second cites the start', () => {
      const live = expectEquivalent([start('E', 'sleep 1'), { pause: true }, end('E', 'sleep 1'), { pause: false }, end('E', 'sleep 1')])
      expect(live.skipped).toEqual([undefined, 'paused', undefined])
      expect(causesOf(live.rows, 'command_end')).toEqual([['#0']])
    })

    it('a chunk after a refused command_end belongs to the still-open command', () => {
      const live = expectEquivalent([start('E2', 'sleep 2 &'), { pause: true }, end('E2', 'sleep 2 &'), { pause: false }, chunk('E2', 0)])
      expect(causesOf(live.rows, 'command_output')).toEqual([['#0']])
    })

    it('a final chunk refused during a pause does not close the command', () => {
      const live = expectEquivalent([
        start('F', 'sleep 3 &'), end('F', 'sleep 3 &', { late_output: true }), chunk('F', 0),
        { pause: true }, chunk('F', 1, { final: true }), { pause: false }, chunk('F', 2)
      ])
      expect(causesOf(live.rows, 'command_output')).toEqual([['#0'], ['#0']])
    })

    it('an http_response refused during a pause does not close the flow', () => {
      const req = { subtype: 'http_request_start', flow_id: 'fp', method: 'GET', url: 'http://10.0.0.7/', host: '10.0.0.7' }
      const res = { subtype: 'http_response', flow_id: 'fp', status_code: 200, url: 'http://10.0.0.7/', host: '10.0.0.7' }
      const live = expectEquivalent([{ scanner: req }, { pause: true }, { scanner: res }, { pause: false }, { scanner: { ...res, status_code: 204 } }])
      expect(causesOf(live.rows, 'http_response')).toEqual([['#0']])
    })
  })

  // Review item 3: a flag means `true`, the JSON boolean, on both sides.
  describe('flags that are not booleans', () => {
    it('late_output: 1 is not a declaration of late output', () => {
      const live = expectEquivalent([start('N', 'sleep 4 &'), end('N', 'sleep 4 &', { late_output: 1 }), chunk('N', 0)])
      expect(live.rows[2].unattributed).toBe(true)
    })
    it('a final chunk before the end that declares late output closes nothing after that end', () => {
      const live = expectEquivalent([
        start('Q', 'sleep 18 &'), chunk('Q', 0, { final: true, late: false, streamed: true }),
        end('Q', 'sleep 18 &', { late_output: true }), chunk('Q', 1)
      ])
      expect(causesOf(live.rows, 'command_output')).toEqual([['#0'], ['#0']])
    })
    it('final: 1 is not the last chunk', () => {
      const live = expectEquivalent([start('M', 'sleep 5 &'), end('M', 'sleep 5 &', { late_output: true }), chunk('M', 0, { final: 1 }), chunk('M', 1)])
      expect(causesOf(live.rows, 'command_output')).toEqual([['#0'], ['#0']])
    })
  })

  // Review items 3 and 4: the key is the `command_id` string exactly as sent.
  describe('the command id', () => {
    it('an id that is not a string is no id; its JSON text is not that id either', () => {
      const live = expectEquivalent([start({ k: 1 }, 'sleep 6', { pid: 61 }), end('{"k":1}', 'sleep 6', { pid: 62 })])
      expect(causesOf(live.rows, 'command_end')).toEqual([undefined])
    })
    it('is compared as sent: no trimming', () => {
      const live = expectEquivalent([
        start(' W1 ', 'sleep 7', { pid: 71 }), end(' W1 ', 'sleep 7', { pid: 72 }),
        start('W2 ', 'sleep 8', { pid: 81 }), end('W2', 'sleep 8', { pid: 82 })
      ])
      expect(causesOf(live.rows, 'command_end')).toEqual([['#0'], undefined])
    })
    it('the camelCase `commandId` is not the key', () => {
      const live = expectEquivalent([
        { shell: { subtype: 'command_start', command: 'sleep 9', terminalId: 't1', pid: 91, commandId: 'A1' } },
        { shell: { subtype: 'command_end', command: 'sleep 9', terminalId: 't1', pid: 92, commandId: 'A1', exit_code: 0 } }
      ])
      expect(causesOf(live.rows, 'command_end')).toEqual([undefined])
    })
    it('one id reused: the second round is its own, whatever the first round\'s chunks said', () => {
      const live = expectEquivalent([
        start('R', 'sleep 10 &'), end('R', 'sleep 10 &', { late_output: true }), chunk('R', 0, { final: true }),
        start('R', 'sleep 11 &'), end('R', 'sleep 11 &', { output_streamed: true }), chunk('R', 0), chunk('R', 1)
      ])
      expect(causesOf(live.rows, 'command_output')).toEqual([['#0'], ['#3'], ['#3']])
    })
    it('two starts with one id: the end cites the newer', () => {
      const live = expectEquivalent([start('D', 'sleep 12', { pid: 121 }), start('D', 'sleep 13', { pid: 131 }), end('D', 'sleep 14', { pid: 141 })])
      expect(causesOf(live.rows, 'command_end')).toEqual([['#1']])
    })
  })

  // Second review F1. The terminal key (terminal + pid + text) is a hint with
  // nothing stored behind it, so it settles when the row arrives, recorded or
  // not, as it always has; only the id maps wait for the commit.
  describe('the terminal key settles at once', () => {
    const nmap = 'nmap -sV 10.0.0.5'
    it('an end refused while paused takes its start off the key: a later command with the same text does not cite it', () => {
      const live = expectEquivalent([
        start('X1', nmap), { pause: true }, end('X1', nmap), start('X2', nmap), { pause: false }, end('X2', nmap)
      ])
      expect(causesOf(live.rows, 'command_end')).toEqual([undefined])
    })
    it('the same without ids', () => {
      const live = expectEquivalent([start(undefined, nmap), { pause: true }, end(undefined, nmap), start(undefined, nmap), { pause: false }, end(undefined, nmap)])
      expect(causesOf(live.rows, 'command_end')).toEqual([undefined])
    })
    it('an end without an id refused while paused and sent again cites nothing, as on main; with an id it cites its start', () => {
      const live = expectEquivalent([
        start(undefined, 'sleep 30', { pid: 301 }), { pause: true }, end(undefined, 'sleep 30', { pid: 301 }), { pause: false }, end(undefined, 'sleep 30', { pid: 301 }),
        start('K', 'sleep 31', { pid: 311 }), { pause: true }, end('K', 'sleep 31', { pid: 311 }), { pause: false }, end('K', 'sleep 31', { pid: 311 })
      ], [])
      expect(causesOf(live.rows, 'command_end')).toEqual([undefined, ['#2']])
    })
  })

  // Second review F2. A command_end sent twice (the hook's curl gave up after
  // the server had committed; the spooled copy arrives more than 2 s later, past
  // the duplicate window). The link is the first end's; the late-output target
  // is whatever the bookkeeping last filed, a late end's or the start's.
  describe('a second command_end for one id', () => {
    const ends = (rows: Row[]) => rows.filter((r) => r.subtype === 'command_end').length
    it('late, final chunk, late again: the chunk after stays unattributed', () => {
      const live = expectEquivalent([
        start('G1', 'sleep 40 &'), end('G1', 'sleep 40 &', { late_output: true }), chunk('G1', 0), chunk('G1', 1, { final: true }),
        { wait: 3000 }, end('G1', 'sleep 40 &', { late_output: true, exit_code: 1 }), chunk('G1', 2)
      ])
      expect(ends(live.rows), 'both ends are stored').toBe(2)
      expect(live.rows[live.rows.length - 1].causes).toBeUndefined()
    })
    it('late under B, then not late under C: the chunk is the command\'s, under B', () => {
      const live = expectEquivalent([
        { target: 'A' }, start('G2', 'sleep 41 &'), { target: 'B' }, end('G2', 'sleep 41 &', { late_output: true }),
        { target: 'C' }, { wait: 3000 }, end('G2', 'sleep 41 &', { exit_code: 1 }), chunk('G2', 0)
      ])
      const last = live.rows[live.rows.length - 1]
      expect(ends(live.rows), 'both ends are stored').toBe(2)
      expect([last.target_id, last.causes]).toEqual(['B', ['#0']])
    })
    it('late under B, then late again under C: the chunk is the command\'s, under C, where the bookkeeping last filed it (as on main)', () => {
      const live = expectEquivalent([
        { target: 'A' }, start('G4', 'sleep 46 &'), { target: 'B' }, end('G4', 'sleep 46 &', { late_output: true }),
        { target: 'C' }, { wait: 3000 }, end('G4', 'sleep 46 &', { late_output: true, exit_code: 1 }), chunk('G4', 0)
      ])
      const last = live.rows[live.rows.length - 1]
      expect(ends(live.rows), 'both ends are stored').toBe(2)
      expect([last.target_id, last.causes]).toEqual(['C', ['#0']])
    })
    it('not late, then late: the chunk stays unattributed', () => {
      const live = expectEquivalent([
        start('G3', 'sleep 42 &'), end('G3', 'sleep 42 &'), { wait: 3000 }, end('G3', 'sleep 42 &', { late_output: true, exit_code: 1 }), chunk('G3', 0)
      ])
      expect(ends(live.rows), 'both ends are stored').toBe(2)
      expect(live.rows[live.rows.length - 1].causes).toBeUndefined()
    })
  })

  // Second review F3.
  it('a reused id\'s first round does not come back after its second round ends', () => {
    const live = expectEquivalent([
      start('H', 'sleep 43 &'), end('H', 'sleep 43 &', { late_output: true }), chunk('H', 0),
      start('H', 'sleep 44 &'), end('H', 'sleep 44 &'), chunk('H', 1)
    ])
    expect(live.rows[live.rows.length - 1].causes).toBeUndefined()
  })

  // Second review F4. A chunk can arrive before its command_start (the relay
  // and the hook are two senders). Main kept its resend after the start once;
  // here the start begins the round's count, so the resend is stored again,
  // live as after a restart (declared in the PR; the reader keeps one row per
  // number). Keeping it once would take a lookup at every command_start.
  it('a chunk before its start, then the start, then the chunk again: stored twice, live as after a restart', () => {
    const live = expectEquivalent([chunk('P', 0), start('P', 'sleep 45 &'), chunk('P', 0)])
    expect(live.skipped).toEqual([undefined, undefined, undefined])
  })

  it('a late chunk takes the target its command\'s late end was filed under, not its start\'s', () => {
    const live = expectEquivalent([{ target: 'A' }, start('T', 'sleep 15 &'), { target: 'C' }, end('T', 'sleep 15 &', { late_output: true }), { target: 'B' }, chunk('T', 0)])
    expect(live.rows.map((r) => r.target_id)).toEqual(['A', 'C', 'C'])
  })

  it('a resent chunk is kept once, before and after a restart and across the final row\'s boundary', () => {
    const live = expectEquivalent([
      start('S', 'sleep 16 &'), end('S', 'sleep 16 &', { late_output: true }), chunk('S', 0), chunk('S', 1), chunk('S', 0),
      chunk('S', 2, { final: true }), chunk('S', 1)
    ])
    // After `final` the numbers are forgotten, live: the resent 1 is stored, unattributed.
    expect(live.skipped).toEqual([undefined, undefined, undefined, undefined, 'dedup', undefined, undefined])
  })

  // Review item 7: a project opened before #795 has rows under `default`; after
  // it, under the project id. Same database, same command.
  it('a command started under `default` and ended under the project id is linked; a view of the project id shows the end without its start', () => {
    const d = fs.mkdtempSync(path.join(dir, 'upgrade-'))
    db.initDB(d)
    db.bindDBEngagement('default')
    ops.ensurePrimaryOperator(OP, 'Eq', ops.generateToken())
    ingestMod._resetIngest()
    const s = ingestMod.ingest({ agentType: 'shell', engagementId: 'default', operatorId: OP, data: { subtype: 'command_start', command: 'sleep 17', terminalId: 't1', pid: 7, command_id: 'U' } })
    closeProject()
    db.initDB(d)
    db.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    const e = ingestMod.ingest({ agentType: 'shell', engagementId: ENG, operatorId: OP, data: { subtype: 'command_end', command: 'sleep 17', terminalId: 't1', pid: 7, command_id: 'U', exit_code: 0 } })
    expect(e.event?.data._causes).toEqual([s.event?.id])
    const inView = db.getDB().prepare(`SELECT id FROM events WHERE engagement_id = ? ORDER BY rowid`).all(ENG) as Array<{ id: string }>
    expect(inView.map((r) => r.id)).toEqual([e.event?.id])
  })
})
