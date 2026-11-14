// Spec 071 SC-003: what a restart costs the links between a command's rows.
//
// The memory maps (causes-resolver.ts, ingest.ts) are the fast path. A row whose
// command they know runs no statement more than before; one they have lost runs
// index seeks on the project's rows (db/stored-links.ts), never a scan. Counted
// with the work counter, not timed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { installWorkCounter, measureWork } from './helpers/work-counter'

const sqlite = requires('better-sqlite3')
installWorkCounter()
const db = await import('../src/core/db/index')
const ops = await import('../src/core/db/operators')
const ingestMod = await import('../src/core/ingest')
const links = await import('../src/core/db/stored-links')

const ENG = 'eng-links'
const OP = 'op-links'
let dir = ''

sqlite.describe('stored links (SC-003)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-links-'))
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ops.ensurePrimaryOperator(OP, 'Links', ops.generateToken())
    ingestMod._resetIngest()
  })
  afterEach(() => {
    db.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const put = (agentType: string, data: Record<string, unknown>) => ingestMod.ingest({ agentType, data, engagementId: ENG, operatorId: OP })
  const start = (cid: string | null, n: number) => put('shell', { subtype: 'command_start', command: `sleep ${n} &`, terminalId: `t${n}`, pid: n, ...(cid ? { command_id: cid } : {}) })
  const end = (cid: string | null, n: number, late = false) => put('shell', { subtype: 'command_end', command: `sleep ${n} &`, terminalId: `t${n}`, pid: n, exit_code: 0, ...(cid ? { command_id: cid } : {}), ...(late ? { late_output: true } : {}) })
  const chunk = (cid: string, seq: number) => put('shell', { subtype: 'command_output', command_id: cid, late: true, seq, stdout: `line ${seq}\n`, final: false })

  describe('every probe is an index seek', () => {
    const probes = (): string[] => {
      const seen: string[] = []
      const conn = db.getDB()
      const prepare = conn.prepare.bind(conn)
      const spy = vi.spyOn(conn, 'prepare').mockImplementation(((sql: string) => { seen.push(sql); return prepare(sql) }) as typeof conn.prepare)
      try {
        links.storedCommand('c1')
        links.storedLastFinal('c1', 0)
        links.storedHighestSeq('c1', 0)
        links.storedSeqSeen('c1', 1, 0)
        links.storedOpenFlowStart('f1')
      } finally { spy.mockRestore() }
      return seen
    }
    const plan = (sql: string): string => {
      const params = (sql.match(/\?/g) ?? []).map((_, i) => (i === 0 ? 'x' : 1))
      return (db.getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(' | ')
    }

    it('each probe is a seek on its index, with no sort', () => {
      const plans = probes().map(plan)
      expect(plans).toEqual([
        'SEARCH events USING INDEX idx_events_shell_command (<expr>=? AND subtype=?)',
        'SEARCH events USING INDEX idx_events_shell_command_final (<expr>=? AND rowid>?)',
        'SEARCH events USING INDEX idx_events_shell_command (<expr>=? AND subtype=?)',
        'SEARCH events USING INDEX idx_events_shell_command (<expr>=? AND subtype=? AND <expr>=? AND rowid>?)',
        'SEARCH events_logged USING INDEX idx_events_logged_http_flow (<expr>=?)'
      ])
    })
  })

  describe('work per row', () => {
    it('a command_end whose start is remembered runs no statement more than one paired by its text', () => {
      start('c1', 1)
      start(null, 2)
      const byId = measureWork(() => end('c1', 1)).work
      const byText = measureWork(() => end(null, 2)).work
      expect(byId.statements).toBe(byText.statements)
    })

    it('after the memory is lost, a command_end runs one seek more and still cites its start', () => {
      start('c1', 1)
      const s = start('c2', 2)
      end('c1', 1)
      ingestMod._resetIngest()
      const lost = measureWork(() => end('c2', 2))
      expect(lost.result.event?.data._causes).toEqual([s.event?.id])
      start('c3', 3)
      const hit = measureWork(() => end('c3', 3)).work
      expect(lost.work.statements - hit.statements).toBe(1)
      expect(lost.work.scans).toBe(hit.scans)
    })

    it('a late chunk whose command is remembered runs no statement more; one after a restart runs three seeks, once', () => {
      start('c1', 1); end('c1', 1, true); chunk('c1', 0)
      const remembered = measureWork(() => chunk('c1', 1)).work
      start('c2', 2); end('c2', 2, true); chunk('c2', 0)
      ingestMod._resetIngest()
      const first = measureWork(() => chunk('c2', 1))
      expect(first.result.event?.data._causes).toHaveLength(1)
      expect(first.work.statements - remembered.statements).toBe(3)
      expect(first.work.scans).toBe(remembered.scans)
      // What the seeks found is remembered again: the next chunk is a hit.
      expect(measureWork(() => chunk('c2', 2)).work.statements).toBe(remembered.statements)
    })

    // Review item 1. A chunk whose command is not open — no start was stored
    // (it was refused while paused), its end did not declare late output, or a
    // `final` chunk came before — must not re-read that id's earlier chunks
    // each time: the relay sends one a second, and ingest runs on the main
    // process.
    describe('a chunk with no open command costs the same however many came before it', () => {
      const tuple = (w: { statements: number; rows: number; scans: number }) => [w.statements, w.rows, w.scans]
      const many = (cid: string, from: number, to: number): void => {
        db.getDB().transaction(() => { for (let i = from; i < to; i++) chunk(cid, i) })()
      }
      const cases: Array<[string, (cid: string) => void]> = [
        ['no stored start', () => {}],
        ['its end did not declare late output', (cid) => { start(cid, 1); end(cid, 1) }],
        ['after its final chunk', (cid) => { start(cid, 2); end(cid, 2, true); put('shell', { subtype: 'command_output', command_id: cid, late: true, seq: -1, stdout: 'last\n', final: true }) }]
      ]
      it.each(cases)('%s: the 2nd, 100th and 1,000th chunk do the same work, and the 1st no more than a constant', (_label, setup) => {
        setup('o1')
        const first = measureWork(() => chunk('o1', 0)).work
        const second = measureWork(() => chunk('o1', 1)).work
        many('o1', 2, 99)
        const hundredth = measureWork(() => chunk('o1', 99)).work
        many('o1', 100, 999)
        const thousandth = measureWork(() => chunk('o1', 999)).work
        expect(tuple(hundredth)).toEqual(tuple(second))
        expect(tuple(thousandth)).toEqual(tuple(second))
        // ...and that is a memory hit: no more than a chunk of a command memory holds open.
        start('k1', 3); end('k1', 3, true); chunk('k1', 0)
        const remembered = measureWork(() => chunk('k1', 1)).work
        expect(second.statements).toBe(remembered.statements)
        expect(first.rows - second.rows).toBeLessThanOrEqual(3)
        // After a restart, the first chunk costs the same with 1,000 stored chunks before it as with one.
        ingestMod._resetIngest()
        const afterMany = measureWork(() => chunk('o1', 1000)).work
        setup('o2'); chunk('o2', 0)
        ingestMod._resetIngest()
        const afterOne = measureWork(() => chunk('o2', 1)).work
        expect(tuple(afterMany)).toEqual(tuple(afterOne))
      })
    })

    it('an HTTP response after a restart runs one seek; what it found is remembered for the error and response after it', () => {
      const req = (flow_id: string) => put('scanner', { subtype: 'http_request_start', flow_id, method: 'GET', url: 'http://10.0.0.8/', host: '10.0.0.8' })
      const after = (flow_id: string, subtype: string) => put('scanner', { subtype, flow_id, url: 'http://10.0.0.8/', host: '10.0.0.8', ...(subtype === 'http_response' ? { status_code: 200 } : {}) })
      req('h1')
      const hit = measureWork(() => after('h1', 'http_error')).work
      req('h2')
      ingestMod._resetIngest()
      const miss = measureWork(() => after('h2', 'http_error'))
      expect(miss.result.event?.data._causes).toHaveLength(1)
      expect(miss.work.statements - hit.statements).toBe(1)
      const again = measureWork(() => after('h2', 'http_error')).work
      expect(again.statements).toBe(hit.statements)
    })
  })
})
