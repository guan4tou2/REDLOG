// Decision 2026-11-15 §2 — a clean scope verdict is a source event of the
// activity it judged. Which rows qualify is asked in two places: in
// JavaScript (`attachedCauseId`, export of an activity or a session) and in
// SQL (`ATTACHED_CAUSE_SQL`, the Activity projection). Both must name the same
// cause for every row, or "export this activity" carries a different set of
// rows from the one the Reader listed.
//
// The predicate is on the row alone; whether the cited row exists in the
// dataset is the caller's question and is not tested here.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { requires } from '../helpers/requires'
import { attachedCauseId, ATTACHED_CAUSE_SQL } from '../../src/core/activity-projection'
import { SCOPE_VIOLATION_SUBTYPE } from '../../src/core/scope-vocabulary'
import { EXAMPLES } from './examples'

const sqlite = requires('better-sqlite3')

interface Row { id: string; agentType: string; data: Record<string, unknown> }
const verdict = (distance: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ subtype: SCOPE_VIOLATION_SUBTYPE, target: '10.20.0.5', action: 'nmap 10.20.0.5', source: 'shell', distance, authority: 'fact', severity: 'info', ...extra })

/** Each edge row and the cause it must name (null: the row stays an activity of its own). */
const EDGES: Array<{ row: Row; cause: string | null }> = [
  { row: { id: 'clean', agentType: 'system', data: verdict('in_scope', { _causes: ['cmd-start'] }) }, cause: 'cmd-start' },
  { row: { id: 'clean-unknown-authority', agentType: 'system', data: verdict('in_scope', { authority: 'unknown', _causes: ['dns-q'] }) }, cause: 'dns-q' },
  { row: { id: 'clean-two-causes', agentType: 'system', data: verdict('in_scope', { _causes: ['first', 'second'] }) }, cause: 'first' },
  { row: { id: 'clean-no-causes', agentType: 'system', data: verdict('in_scope') }, cause: null },
  { row: { id: 'clean-empty-causes', agentType: 'system', data: verdict('in_scope', { _causes: [] }) }, cause: null },
  { row: { id: 'clean-number-cause', agentType: 'system', data: verdict('in_scope', { _causes: [42] }) }, cause: null },
  { row: { id: 'clean-null-cause', agentType: 'system', data: verdict('in_scope', { _causes: [null] }) }, cause: null },
  { row: { id: 'clean-object-cause', agentType: 'system', data: verdict('in_scope', { _causes: [{ id: 'x' }] }) }, cause: null },
  { row: { id: 'clean-string-causes', agentType: 'system', data: verdict('in_scope', { _causes: 'cmd-start' }) }, cause: null },
  { row: { id: 'clean-object-causes', agentType: 'system', data: verdict('in_scope', { _causes: { 0: 'cmd-start' } }) }, cause: null },
  { row: { id: 'no-distance', agentType: 'system', data: { subtype: SCOPE_VIOLATION_SUBTYPE, target: 't', _causes: ['c'] } }, cause: null },
  ...(['excluded', 'adjacent_subnet', 'adjacent_domain', 'unrelated', 'out_of_scope'] as const).map((d) => (
    { row: { id: `distance-${d}`, agentType: 'system', data: verdict(d, { _causes: ['cmd-start'] }) }, cause: null })),
  { row: { id: 'scope-cleared', agentType: 'system', data: { subtype: 'scope_cleared', distance_before: 'excluded', distance_after: 'in_scope', distance: 'in_scope', _causes: ['viol', 'run'] } }, cause: null },
  { row: { id: 'not-system', agentType: 'process', data: verdict('in_scope', { _causes: ['cmd-start'] }) }, cause: null },
  { row: { id: 'scanner-same-subtype', agentType: 'scanner', data: verdict('in_scope', { _causes: ['cmd-start'] }) }, cause: null }
]

const ALL: Row[] = [...EXAMPLES.map((e) => ({ id: e.id, agentType: e.row.agentType, data: e.row.data })), ...EDGES.map((e) => e.row)]

describe('attachedCauseId (JavaScript)', () => {
  it.each(EDGES.map((e) => [e.row.id, e]))('%s', (_id, e) => {
    expect(attachedCauseId(e.row)).toBe(e.cause)
  })

  it('no example kind row attaches: none of them cites a cause', () => {
    expect(EXAMPLES.filter((e) => attachedCauseId(e.row) !== null).map((e) => e.id)).toEqual([])
  })
})

sqlite.describe('ATTACHED_CAUSE_SQL agrees with attachedCauseId on every row', () => {
  const db = sqlite.ok ? new (createRequire(__filename)('better-sqlite3') as new (f: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
  })(':memory:') : (null as never)

  it('names the same cause, or none, for each example and edge row', () => {
    db.exec('CREATE TABLE ev (id TEXT, agent_type TEXT, subtype TEXT, data TEXT)')
    const insert = db.prepare('INSERT INTO ev (id, agent_type, subtype, data) VALUES (?, ?, ?, ?)')
    db.exec('BEGIN')
    for (const r of ALL) insert.run(r.id, r.agentType, typeof r.data.subtype === 'string' ? r.data.subtype : null, JSON.stringify(r.data))
    db.exec('COMMIT')
    const sql = Object.fromEntries((db.prepare(`SELECT id, ${ATTACHED_CAUSE_SQL} AS cause FROM ev`).all() as Array<{ id: string; cause: string | null }>).map((r) => [r.id, r.cause]))
    const js = Object.fromEntries(ALL.map((r) => [r.id, attachedCauseId(r)]))
    expect(sql).toEqual(js)
    // and the agreement is not the trivial one
    expect(Object.values(js).filter((c) => c !== null)).toEqual(['cmd-start', 'dns-q', 'first'])
  })
})
