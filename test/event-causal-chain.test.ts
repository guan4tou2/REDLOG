import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let events: typeof import('../src/core/db/events')
let dbmod: typeof import('../src/core/db/index')
let ops: typeof import('../src/core/db/operators')
try {
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  ops = await import('../src/core/db/operators')
} catch { /* better-sqlite3 unavailable */ }
const describeDB = events! && dbmod! && ops! ? describe : describe.skip

describeDB('queryEventCausalChain', () => {
  let dir: string
  let operatorId: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-causal-'))
    dbmod.initDB(dir)
    operatorId = ops.ensurePrimaryOperator('causal-op', 'Causal Op', 'tok-causal').id
  })
  afterEach(() => { dbmod.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const add = (agentType: string, data: Record<string, unknown>) => {
    const row = events.insertEvent(agentType, data, { operatorId })
    if (!row) throw new Error('event not inserted')
    return row
  }

  it('walks causes and effects across chained and logged tiers', () => {
    const root = add('shell', { subtype: 'command_end', command: 'curl example.test' })
    const request = add('scanner', { subtype: 'http_request_start', url: 'https://example.test', _causes: [root.id] })
    const finding = add('marker', { subtype: 'created', title: 'finding', _causes: [request.id] })

    const result = events.queryEventCausalChain(request.id)
    expect(new Set(result.events.map((e) => e.id))).toEqual(new Set([root.id, request.id, finding.id]))
    expect(result.edges).toEqual(expect.arrayContaining([
      { causeId: root.id, effectId: request.id },
      { causeId: request.id, effectId: finding.id }
    ]))
    expect(result.unavailableCauseIds).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('reports unavailable referenced events without inventing a reason', () => {
    const anchor = add('marker', { subtype: 'created', title: 'orphan', _causes: ['missing-event'] })
    const result = events.queryEventCausalChain(anchor.id)
    expect(result.events.map((e) => e.id)).toEqual([anchor.id])
    expect(result.unavailableCauseIds).toEqual(['missing-event'])
    expect(result.truncated).toBe(false)
  })

  it('deduplicates cycles and terminates', () => {
    const aId = 'cycle-a'
    const bId = 'cycle-b'
    const insert = dbmod.getDB().prepare(`INSERT INTO events_logged
      (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
      VALUES (?,?,?,?,?,'scanner','http_response','host',?,?)`)
    insert.run(aId, 1, 'eng', 'sess', operatorId, JSON.stringify({ _causes: [bId] }), 1)
    insert.run(bId, 2, 'eng', 'sess', operatorId, JSON.stringify({ _causes: [aId] }), 2)
    const result = events.queryEventCausalChain(aId)
    expect(new Set(result.events.map((e) => e.id))).toEqual(new Set([aId, bId]))
    expect(new Set(result.edges.map((e) => `${e.causeId}>${e.effectId}`)).size).toBe(2)
  })

  it('sets truncated when the event limit omits reachable nodes', () => {
    const root = add('shell', { subtype: 'command_end', command: 'root' })
    let parent = root
    for (let i = 0; i < 5; i++) parent = add('marker', { subtype: 'created', title: String(i), _causes: [parent.id] })
    const result = events.queryEventCausalChain(root.id, { eventLimit: 3 })
    expect(result.events).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('does not claim truncation when a limit lands exactly on a leaf', () => {
    const root = add('shell', { subtype: 'command_end', command: 'root' })
    const leaf = add('marker', { subtype: 'created', title: 'leaf', _causes: [root.id] })
    expect(events.queryEventCausalChain(root.id, { eventLimit: 2 }).truncated).toBe(false)
    expect(events.queryEventCausalChain(root.id, { maxDepth: 1 }).truncated).toBe(false)
    expect(events.queryEventCausalChain(leaf.id, { maxDepth: 0 }).truncated).toBe(true)
    expect(events.queryEventCausalChain(add('marker', { subtype: 'created', title: 'isolated' }).id, { maxDepth: 0 }).truncated).toBe(false)
  })

  it('returns an explicit absent anchor result', () => {
    const result = events.queryEventCausalChain('absent')
    expect(result.anchorFound).toBe(false)
    expect(result.events).toEqual([])
  })
})
