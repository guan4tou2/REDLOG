import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { storeBody } from '../src/core/http-body-store'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { parseQuery } from '../src/core/query/contract'
import { queryActivityPage, queryActivityMembers } from '../src/core/db/activity-queries'
import type { ActivityRequest } from '../src/core/activity-contract'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-activity-')); initDB(dir) })
afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
function add(id: string, ts: number, type: string, data: Record<string, unknown>, opts: { tier?: 'chained' | 'logged'; project?: string; binding?: string; target?: string } = {}): void {
  const table = opts.tier === 'logged' ? 'events_logged' : 'events'
  getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${table === 'events' ? ',hash,prev_hash' : ''})
    VALUES (?,?,?,?,?,?,?,'host',NULL,?,?,?${table === 'events' ? ", 'fixture-hash', NULL" : ''})`).run(
    id, ts, opts.project ?? 'eng', opts.binding ?? 'binding', 'operator', type, String(data.subtype ?? ''), opts.target ?? null, JSON.stringify(data), ts)
}
const tool = (subtype: string, id: string, more: Record<string, unknown> = {}) => ({ subtype, agent: 'claude-code', session_id: 'conversation', tool_use_id: id, ...more })
function request(query = '', extra: Partial<ActivityRequest> = {}): ActivityRequest {
  const parsed = parseQuery(query); if (!parsed.ok) throw new Error('bad fixture query')
  return { projectId: 'eng', parsed: parsed.parsed, ...extra }
}

describe('Activity project query', () => {
  it('binds paging to saved-body coverage inside its dataset boundary', () => {
    const makeRef=(text:string)=>storeBody({data:text,encoding:'text',size:text.length,sha256:''})!
    const ref=makeRef('unrelated saved output')
    add('first-inline',30,'marker',{title:'needle'})
    add('second-inline',20,'marker',{title:'needle'})
    add('body-owner',10,'shell',{subtype:'command_end',command_id:'body',stdout_ref:ref})
    const req=request('needle',{limit:1}),first=queryActivityPage(req)
    add('later-body',40,'shell',{subtype:'command_end',command_id:'later',stdout_ref:makeRef('another body')})
    expect(queryActivityPage({...req,cursor:first.nextCursor}).items).toHaveLength(1)
    fs.unlinkSync(path.join(dir,'http-bodies',ref.file))
    expect(()=>queryActivityPage({...req,cursor:first.nextCursor})).toThrow(/coverage changed/)
  })

  it('can show matching source rows first without dropping paged context', () => {
    add('call-first', 10, 'agent', tool('tool_call', 'M', { tool_name: 'Bash', tool_input: { command: 'id' } }))
    add('result-last', 20, 'agent', tool('tool_result', 'M', { output: 'needle' }))
    const req = request('needle'), page = queryActivityPage(req)
    const detail = { ...req, ref: page.items[0], snapshot: page.snapshot, matchesFirst: true, limit: 1 }
    const first = queryActivityMembers(detail)
    expect(first.items.map(r => r.event.id)).toEqual(['result-last'])
    const next = queryActivityMembers({ ...detail, cursor: first.nextCursor })
    expect(next.items.map(r => r.event.id)).toEqual(['call-first'])
    expect(next.hasMore).toBe(false)
    expect(() => queryActivityMembers({ ...detail, matchesFirst: false, cursor: first.nextCursor })).toThrow(/cursor|query/)
  })

  it('keeps one stable ID when a Result precedes or follows its Call', () => {
    add('result', 200, 'agent', tool('tool_result', 'T', { output: 'answer' }))
    const alone = queryActivityPage(request()).items[0]
    expect(alone.id).toMatch(/^act1:[a-f0-9]{64}$/)
    expect(alone.state).toBe('result-only')
    add('call', 100, 'agent', tool('tool_call', 'T', { tool_name: 'Bash', tool_input: { command: 'id' } }))
    const paired = queryActivityPage(request()).items[0]
    expect(paired.id).toBe(alone.id)
    expect(paired.state).toBe('paired')
    expect(paired.anchor.id).toBe('call')
    expect(paired.sourcePreview.ids.sort()).toEqual(['call', 'result'])
    expect(getDB().prepare('SELECT hash FROM events WHERE id=?').get('result')).toEqual({ hash: 'fixture-hash' })
  })

  it('groups before paging and separates matching rows from source context', () => {
    for (let i = 0; i < 5; i++) {
      add(`c${i}`, 100 + i, 'agent', tool('tool_call', `T${i}`, { tool_name: 'Read', tool_input: { path: 'file' } }))
      add(`r${i}`, 500 + i, 'agent', tool('tool_result', `T${i}`, { output: 'needle' }))
    }
    let page = queryActivityPage(request('needle', { limit: 2 })); const ids: string[] = []
    expect(page.totalGroups).toBe(5); expect(page.totalMatches).toBe(5)
    do {
      ids.push(...page.items.map(a => a.id))
      for (const a of page.items) { expect(a.matchedCount).toBe(1); expect(a.contextCount).toBe(1); expect(a.anchor.data.tool_name).toBe('Read') }
      if (!page.nextCursor) break
      page = queryActivityPage(request('needle', { limit: 2, cursor: page.nextCursor }))
    } while (true)
    expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5)
  })

  it('freezes pages across new and late data, but a refresh updates the original group', () => {
    add('a', 100, 'agent', tool('tool_call', 'A', { tool_name: 'Bash' }))
    add('b', 200, 'agent', tool('tool_call', 'B', { tool_name: 'Read' }))
    const first = queryActivityPage(request('', { limit: 1 }))
    add('new', 300, 'marker', { title: 'new' })
    add('late', 500, 'agent', tool('tool_result', 'A', { output: 'late' }))
    const next = queryActivityPage(request('', { limit: 1, cursor: first.nextCursor }))
    expect(next.totalGroups).toBe(2); expect(next.items[0].state).toBe('call-only'); expect(next.hasMore).toBe(false)
    const refreshed = queryActivityPage(request())
    expect(refreshed.items.find(a => a.id === next.items[0].id)?.state).toBe('paired')
    expect(refreshed.totalGroups).toBe(3)
  })

  it('does not merge a different provider, source Session, binding or project', () => {
    add('call', 100, 'agent', tool('tool_call', 'T', { tool_name: 'Bash' }))
    add('provider', 200, 'agent', tool('tool_result', 'T', { agent: 'codex', output: 'other provider' }))
    add('session', 300, 'agent', tool('tool_result', 'T', { session_id: 'other', output: 'other session' }))
    add('binding', 400, 'agent', tool('tool_result', 'T', { output: 'other binding' }), { binding: 'other' })
    add('project', 500, 'agent', tool('tool_result', 'T', { output: 'foreign' }), { project: 'other' })
    const page = queryActivityPage(request())
    expect(page.totalGroups).toBe(4); expect(page.totalMatches).toBe(4)
    expect(new Set(page.items.map(a => a.id)).size).toBe(4)
  })

  it('keeps conflicts and unknown orphan Events rather than choosing the last result', () => {
    add('c', 100, 'agent', tool('tool_call', 'T', { tool_name: 'Bash' }))
    add('r1', 200, 'agent', tool('tool_result', 'T', { output: 'first' }))
    add('r2', 300, 'agent', tool('tool_result', 'T', { output: 'conflict' }))
    add('unknown1', 400, 'shell', { subtype: 'command_start', pid: 7, command: 'ls' })
    add('unknown2', 500, 'shell', { subtype: 'command_end', pid: 7, command: 'ls' })
    const page = queryActivityPage(request())
    expect(page.totalGroups).toBe(3)
    expect(page.items.find(a => a.kind === 'tool')?.state).toBe('conflicted')
    expect(page.items.find(a => a.kind === 'tool')?.sourceCount).toBe(3)
  })

  it('reads both tiers, keeps HTTP exchange identity, and applies filters before grouping totals', () => {
    add('req', 100, 'scanner', { subtype: 'http_request_start', flow_id: 'F', url: 'https://a.test/' }, { tier: 'logged', target: 'a.test' })
    add('res', 200, 'scanner', { subtype: 'http_response', flow_id: 'F', status: 200 }, { tier: 'logged', target: 'a.test' })
    add('other', 300, 'marker', { title: 'other' }, { target: 'b.test' })
    const page = queryActivityPage(request('', { filter: { targetId: 'A.TEST' } }))
    expect(page.totalGroups).toBe(1); expect(page.totalMatches).toBe(2)
    expect(page.items[0]).toMatchObject({ kind: 'http', state: 'paired', sourceCount: 2 })
    expect(queryActivityPage(request('', { filter: { tier: 'chained' } })).totalGroups).toBe(1)
  })

  it('bounds member previews without losing full group membership or original match location', () => {
    add('c', 100, 'agent', tool('tool_call', 'T', { tool_name: 'Bash' }))
    for (let i = 0; i < 125; i++) add(`r${i}`, 200 + i, 'agent', tool('tool_result', 'T', { output: `needle ${i}` }))
    const page = queryActivityPage(request('needle'))
    const a = page.items[0]
    expect(a.sourceCount).toBe(126); expect(a.sourcePreview.hasMore).toBe(true)
    let members = queryActivityMembers({ ...request('needle'), snapshot: page.snapshot, ref: a, limit: 30 })
    const ids: string[] = []; let matches = 0
    do {
      ids.push(...members.items.map(m => m.event.id)); matches += members.items.filter(m => m.matched).length
      if (!members.nextCursor) break
      members = queryActivityMembers({ ...request('needle'), snapshot: page.snapshot, ref: a, limit: 30, cursor: members.nextCursor })
    } while (true)
    expect(new Set(ids).size).toBe(126); expect(matches).toBe(125)
  })

  it('rejects changed query/project cursors and source retention instead of returning a partial success', () => {
    add('a', 100, 'marker', { title: 'needle' }); add('b', 200, 'marker', { title: 'needle' })
    const page = queryActivityPage(request('needle', { limit: 1 }))
    expect(() => queryActivityPage(request('different', { cursor: page.nextCursor }))).toThrow(/cursor|query/i)
    expect(() => queryActivityPage(request('needle', { projectId: 'other', cursor: page.nextCursor }))).toThrow(/cursor|project/i)
    expect(() => queryActivityPage(request('', { cursor: 'broken' }))).toThrow(/cursor/i)
    // Retention fixture: an authorized deletion is a changed source dataset.
    getDB().exec('DROP TRIGGER IF EXISTS events_no_delete')
    for (const trigger of getDB().prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events' AND sql LIKE '%BEFORE DELETE%'").all() as { name: string }[]) getDB().exec(`DROP TRIGGER "${trigger.name}"`)
    getDB().prepare('DELETE FROM events WHERE id=?').run('a')
    expect(() => queryActivityPage(request('needle', { cursor: page.nextCursor }))).toThrow(/dataset|changed|retention/i)
  })
  it('classifies known AI tool schemas without turning unknown names or browsing into shell observations', () => {
    const cases = [
      ['claude-code', 'Bash', 'execute', 'command'], ['claude-code', 'Read', 'file-read', 'conversation'],
      ['claude-code', 'Edit', 'file-write', 'conversation'], ['claude-code', 'Grep', 'search', 'conversation'],
      ['claude-code', 'WebFetch', 'browse', 'conversation'], ['claude-code', 'ReadBashSecret', 'unknown', 'conversation'],
      ['codex', 'functions.exec_command', 'execute', 'command'], ['codex', 'functions.apply_patch', 'file-write', 'conversation'],
      ['codex', 'web.run', 'browse', 'conversation'], ['codex', 'Bash', 'unknown', 'conversation']
    ]
    cases.forEach(([agent, name], i) => {
      add(`tool-c${i}`, i * 2, 'agent', tool('tool_call', `T${i}`, { agent, tool_name: name }))
      add(`tool-r${i}`, i * 2 + 1, 'agent', tool('tool_result', `T${i}`, { agent, output: 'needle' }))
    })
    const all = queryActivityPage(request('needle'))
    for (const [i, [provider, , toolAction, action]] of cases.entries()) {
      expect(all.items.find(a => a.anchor.id === `tool-c${i}`)).toMatchObject({ provider, toolAction, action, matchedCount: 1, contextCount: 1 })
    }
    const commands = queryActivityPage(request('needle', { activityFilter: { actions: ['command'], providers: ['claude-code', 'codex'] } }))
    expect(commands.totalGroups).toBe(2); expect(commands.totalMatches).toBe(2)
    const read = queryActivityPage(request('needle', { activityFilter: { toolActions: ['file-read'] } }))
    expect(read.items.map(a => a.anchor.data.tool_name)).toEqual(['Read'])
    expect(queryActivityPage(request('needle', { activityFilter: { actions: ['network'] } })).totalGroups).toBe(0)
  })

  it('rejects invalid typed Activity filters instead of implying that nothing matches', () => {
    expect(() => queryActivityPage(request('', { activityFilter: { actions: ['typo'] as never } }))).toThrow(/filter/i)
    expect(() => queryActivityPage(request('', { activityFilter: { states: ['running'] as never } }))).toThrow(/filter/i)
    expect(() => queryActivityPage(request('', { activityFilter: { toolActions: ['bash'] as never } }))).toThrow(/filter/i)
  })

  it('refreshes the projection after retention and a failed stale read', () => {
    add('old', 100, 'marker', { title: 'old' })
    const before = queryActivityPage(request())
    for (const trigger of getDB().prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events' AND sql LIKE '%BEFORE DELETE%'").all() as { name: string }[]) getDB().exec(`DROP TRIGGER "${trigger.name}"`)
    getDB().prepare('DELETE FROM events WHERE id=?').run('old')
    add('replacement', 200, 'marker', { title: 'new' })
    expect(() => queryActivityMembers({ ...request(), ref: before.items[0], snapshot: before.snapshot })).toThrow(/changed|retention/)
    const refreshed = queryActivityPage(request())
    expect(refreshed.items.map(a => a.anchor.id)).toEqual(['replacement'])
    expect(refreshed.totalMatches).toBe(1)
    expect(queryActivityPage(request()).items[0].id).toBe(refreshed.items[0].id)
  })

  it('requires the confirmed snapshot when opening source context', () => {
    add('row',100,'marker',{title:'example'})
    const page=queryActivityPage(request())
    expect(() => queryActivityMembers({...request(),ref:page.items[0]} as never)).toThrow(/snapshot/i)
  })

  it('recovers after a partial index build fails, and preserves IDs across project reopen', () => {
    add('first',100,'marker',{title:'first'})
    const first=queryActivityPage(request()).items[0].id
    add('second',200,'marker',{title:'second'})
    // A readable SQLite row with an invalid Event payload forces failure after
    // a new valid row has been visited, rather than before indexing starts.
    getDB().exec(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
      VALUES ('corrupt',300,'eng','binding','operator','marker','marker','host','null',300,'fixture-hash')`)
    expect(() => queryActivityPage(request())).toThrow(/payload/i)
    for(const trigger of getDB().prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events' AND sql LIKE '%BEFORE DELETE%'").all() as {name:string}[]) getDB().exec(`DROP TRIGGER "${trigger.name}"`)
    getDB().prepare('DELETE FROM events WHERE id=?').run('corrupt')
    expect(queryActivityPage(request()).totalGroups).toBe(2)
    closeDB(); initDB(dir)
    const reopened=queryActivityPage(request())
    expect(reopened.items.map(a=>a.anchor.id)).toEqual(['second','first'])
    expect(reopened.items.find(a=>a.anchor.id==='first')?.id).toBe(first)
  })

})
