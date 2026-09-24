import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseQuery } from '../src/core/query/contract'
import { initDB, closeDB } from '../src/core/db/index'
import { executeEventQuery } from '../src/core/db/events'
import { insertFixtureRow } from './helpers/timeline-query-fixture'

// Spec 038 FR-009 / research R7: ⌘K's operator pick lands on the Timeline
// as `operator:<id>`, matched on the recorded operator. It used to set the
// operator's display name as substring text, which matched only because the
// Timeline's own search bag happened to include operator names; the query
// contract indexes neither.
describe('the operator: condition', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-038-operator-'))
    initDB(dir)
    const base = { agentType: 'shell', subtype: 'command_end', targetId: null }
    insertFixtureRow({ ...base, table: 'events', id: 'a1', timestamp: 3, operatorId: 'op-2', data: { command: 'id' } })
    insertFixtureRow({ ...base, table: 'events_logged', id: 'a2', timestamp: 2, operatorId: 'op-2', data: { command: 'ls' } })
    // Mentions op-2 in its text, but op-1 ran it.
    insertFixtureRow({ ...base, table: 'events', id: 'b1', timestamp: 1, operatorId: 'op-1', data: { command: 'echo op-2' } })
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('parses as a condition on a recognised field', () => {
    const out = parseQuery('operator:op-2')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.parsed.conditions).toEqual([{ field: 'operator', value: 'op-2' }])
      expect(out.parsed.tokens).toEqual([{ raw: 'operator:op-2', read: 'condition' }])
    }
  })

  it('refuses a half-typed condition rather than reading it as text', () => {
    const out = parseQuery('operator:')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('empty-condition-value')
  })

  it('matches the recorded operator in both tiers, never the text', () => {
    const out = parseQuery('operator:op-2')
    if (!out.ok) throw new Error('parse')
    const ids = executeEventQuery({ parsed: out.parsed, limit: 10 }).items.map((e) => e.id).sort()
    expect(ids).toEqual(['a1', 'a2'])
  })
})
