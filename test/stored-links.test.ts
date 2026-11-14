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
        links.storedCommand('c1', true)
        links.storedOpenFlowStart('f1')
      } finally { spy.mockRestore() }
      return seen
    }
    const plan = (sql: string): string => (db.getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as Array<{ detail: string }>).map((r) => r.detail).join(' | ')

    it('the command probes use idx_events_shell_command, the flow probe idx_events_logged_http_flow', () => {
      const plans = probes().map(plan)
      expect(plans).toHaveLength(3)
      expect(plans[0]).toMatch(/^SEARCH events USING INDEX idx_events_shell_command \(<expr>=\? AND subtype=\?\)$/)
      expect(plans[1]).toMatch(/^SEARCH events USING INDEX idx_events_shell_command \(<expr>=\? AND subtype=\?\)$/)
      expect(plans[2]).toMatch(/^SEARCH events_logged USING INDEX idx_events_logged_http_flow \(<expr>=\?\)$/)
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

    it('a late chunk whose command is remembered runs no statement more; one after a restart runs two seeks, once', () => {
      start('c1', 1); end('c1', 1, true); chunk('c1', 0)
      const remembered = measureWork(() => chunk('c1', 1)).work
      start('c2', 2); end('c2', 2, true); chunk('c2', 0)
      ingestMod._resetIngest()
      const first = measureWork(() => chunk('c2', 1))
      expect(first.result.event?.data._causes).toHaveLength(1)
      expect(first.work.statements - remembered.statements).toBe(2)
      expect(first.work.scans).toBe(remembered.scans)
      // What the seeks found is remembered again: the next chunk is a hit.
      expect(measureWork(() => chunk('c2', 2)).work.statements).toBe(remembered.statements)
    })
  })
})
