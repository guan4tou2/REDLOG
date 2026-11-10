import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { querySourceSessions } from '../src/core/source-sessions'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-source-session-query-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

function add(id: string, ts: number, data: Record<string, unknown>, opts: { project?: string; binding?: string; type?: string } = {}): void {
  getDB().prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at,hash,prev_hash)
    VALUES (?,?,?,?,?,?,?,'host',NULL,NULL,?,?,'fixture-hash',NULL)`).run(
    id, ts, opts.project ?? 'eng', opts.binding ?? 'binding', 'operator', opts.type ?? 'agent', String(data.subtype ?? ''), JSON.stringify(data), ts)
}
const say = (id: string, ts: number, sessionId: string, agent = 'claude-code', binding = 'binding'): void =>
  add(id, ts, { subtype: 'assistant_message', agent, session_id: sessionId, full: 'x' }, { binding })
const ids = (query?: string, extra: object = {}): string[] =>
  querySourceSessions({ projectId: 'eng', kind: 'agent', query, ...extra }).items.map(item => item.sessionId)

it('finds a Session by id, source or capture id, ignoring ASCII case', () => {
  say('a', Date.UTC(2026, 10, 9, 15, 42), 'Refactor-Auth')
  say('b', Date.UTC(2026, 10, 9, 11, 20), 'fix-login', 'codex')
  say('c', Date.UTC(2026, 10, 8, 22, 10), 'notes', 'claude-code', 'cap-Z9')
  expect(ids('refactor')).toEqual(['Refactor-Auth'])
  expect(ids('AUTH')).toEqual(['Refactor-Auth'])
  expect(ids('codex')).toEqual(['fix-login'])
  expect(ids('cap-z9')).toEqual(['notes'])
  expect(ids('')).toHaveLength(3)
  expect(ids('   ')).toHaveLength(3)
  expect(ids('nothing-like-this')).toEqual([])
})

it('matches the UTC time text of the first and last Event, and needs every term', () => {
  say('a', Date.UTC(2026, 10, 9, 15, 42), 'one')
  say('b', Date.UTC(2026, 10, 9, 16, 5), 'one')
  say('c', Date.UTC(2026, 10, 1, 8, 0), 'two')
  expect(ids('2026-11-09 15:42')).toEqual(['one'])
  expect(ids('2026-11-09 16:05')).toEqual(['one'])
  expect(ids('2026-11-01')).toEqual(['two'])
  expect(ids('2026-11 one')).toEqual(['one'])
  expect(ids('2026-11 two one')).toEqual([])
})

it('counts only matches in `total` and keeps paging inside the same search', () => {
  for (let i = 0; i < 30; i++) say(`e${i}`, 1_000 + i, `auth-${String(i).padStart(2, '0')}`)
  for (let i = 0; i < 10; i++) say(`o${i}`, 5_000 + i, `other-${i}`)
  const first = querySourceSessions({ projectId: 'eng', kind: 'agent', query: 'auth', limit: 10 })
  expect(first.total).toBe(30)
  expect(first.items).toHaveLength(10)
  expect(first.hasMore).toBe(true)
  const second = querySourceSessions({ projectId: 'eng', kind: 'agent', query: 'auth', limit: 10, cursor: first.nextCursor })
  expect(second.items.every(item => item.sessionId.startsWith('auth-'))).toBe(true)
  expect(new Set([...first.items, ...second.items].map(item => item.token)).size).toBe(20)
  // A page of one search cannot be continued under another.
  expect(() => querySourceSessions({ projectId: 'eng', kind: 'agent', query: 'other', limit: 10, cursor: first.nextCursor })).toThrow(/cursor/)
  expect(() => querySourceSessions({ projectId: 'eng', kind: 'agent', limit: 10, cursor: first.nextCursor })).toThrow(/cursor/)
})

it('stays inside the project, kind and provider, and treats SQL punctuation as text', () => {
  say('a', 100, '100%_done', 'claude-code')
  say('b', 200, '100xdone', 'codex')
  add('p', 300, { subtype: 'assistant_message', agent: 'claude-code', session_id: 'private' }, { project: 'other' })
  expect(ids('100%')).toEqual(['100%_done'])
  expect(ids("' OR 1=1 --")).toEqual([])
  expect(ids('private')).toEqual([])
  expect(ids('done', { provider: 'codex' })).toEqual(['100xdone'])
  expect(ids('claude', { provider: 'codex' })).toEqual([])
})

it('refuses an unbounded query instead of cutting it', () => {
  say('a', 100, 'one')
  expect(() => ids('x'.repeat(65))).toThrow(/query/)
  expect(() => ids('a b c d e f g h i')).toThrow(/query/)
  expect(() => ids('a b c d e f g h')).not.toThrow()
  expect(() => querySourceSessions({ projectId: 'eng', kind: 'agent', query: 7 as unknown as string })).toThrow(/query/)
})
