// Spec 017 T002-T004 — RED.
//
// What a condition MATCHES, as opposed to what the input means (T001).
//
// Two facts from the store shape these tests, and both were found by writing
// the seeding rather than by reading the spec:
//
//   "Session" names two identifiers. The `session_id` column is RedLog's
//   per-process capture session — `event-write.ts` records that no consumer
//   filters on it. The one an operator holds, from a transcript or the
//   Timeline detail panel, is `data.session_id`, the agent's session. These
//   tests seed and assert the latter; a condition resolving the column would
//   match nothing anyone pastes.
//
//   A tool-use ID is unique only within a session — `buildBlocks` has always
//   paired on `${session_id}:${tool_use_id}`. Choosing a session silently
//   would let counterpart completion join a call from one session to a result
//   from another and present it as one exchange.
//
// T004 covers the other direction: `data` is indexed by FTS as a single blob,
// so an identifier quoted inside command output is findable as text. A
// condition that accepted such a hit would report evidence the operator did
// not ask for as an exact match on a field.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ParsedQuery, QueryCondition } from '../src/core/query/contract'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let insertEvent: typeof import('../src/core/db/event-write').insertEvent
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let available = false

try {
  const db = await import('../src/core/db')
  const write = await import('../src/core/db/event-write')
  const queries = await import('../src/core/db/event-queries')
  const bodyIndex = await import('../src/core/http-body-index')
  initDB = db.initDB
  closeDB = db.closeDB
  insertEvent = write.insertEvent
  closeHttpBodyIndex = bodyIndex.closeHttpBodyIndex
  executeEventQuery = queries.executeEventQuery
  available = true
} catch { /* native SQLite unavailable */ }

const describeDB = available ? describe : describe.skip
let dir: string

/** Build a parse result directly; T001 covers producing one from text. */
function query(conditions: QueryCondition[], text = ''): ParsedQuery {
  return {
    conditions,
    text,
    tokens: [
      ...conditions.map((c) => ({ raw: `${c.field}:${c.value}`, read: 'condition' as const })),
      ...(text ? [{ raw: text, read: 'text' as const }] : [])
    ]
  }
}

/** Returns the stored event id; ids are assigned by the writer, not by us. */
function seed(agentType: string, data: Record<string, unknown>): string {
  const event = insertEvent(agentType, data, { operatorId: 'op' })
  if (!event) throw new Error('insertEvent returned null; capture is paused')
  return event.id
}

function agentEvent(sessionId: string, over: Record<string, unknown> = {}): string {
  return seed('agent', { subtype: 'assistant_message', session_id: sessionId, ...over })
}

function ids(result: { items: Array<{ id: string }> }): string[] {
  return result.items.map((e) => e.id).sort()
}

function agentSessionOf(event: { data: Record<string, unknown> }): unknown {
  return event.data.session_id
}

function withTempDb(name: string): void {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-${name}-`))
    initDB(dir)
  })
  afterEach(() => {
    // A text query opens the http-body index; Windows refuses to unlink
    // an open file, so leaving it open fails the cleanup, not the assertion.
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

describeDB('query conditions — exact, project-wide fields (T002)', () => {
  withTempDb('query-resolve')

  it('resolves an event ID to exactly that event', () => {
    const wanted = agentEvent('S1')
    agentEvent('S1')
    const result = executeEventQuery({ parsed: query([{ field: 'event', value: wanted }]) })
    expect(ids(result)).toEqual([wanted])
  })

  it('does not substitute a near match for an event ID', () => {
    const wanted = agentEvent('S1')
    const truncated = wanted.slice(0, -2)
    const result = executeEventQuery({ parsed: query([{ field: 'event', value: truncated }]) })
    expect(result.items).toEqual([])
  })

  it('resolves an agent session ID to every event of that session', () => {
    const a = agentEvent('S-target')
    const b = agentEvent('S-target')
    agentEvent('S-other')
    const result = executeEventQuery({ parsed: query([{ field: 'session', value: 'S-target' }]) })
    expect(ids(result)).toEqual([a, b].sort())
  })

  it('resolves a transcript UUID to that transcript', () => {
    const a = agentEvent('S1', { transcript_uuid: 'tr-1' })
    agentEvent('S1', { transcript_uuid: 'tr-2' })
    const result = executeEventQuery({ parsed: query([{ field: 'transcript', value: 'tr-1' }]) })
    expect(ids(result)).toEqual([a])
  })

  it('returns an empty page, not a failure, when a condition matches nothing', () => {
    agentEvent('S1')
    const result = executeEventQuery({ parsed: query([{ field: 'session', value: 'absent' }]) })
    expect(result.items).toEqual([])
    expect(result.hasMore).toBe(false)
  })

  it('intersects a condition with free text rather than widening to either', () => {
    const both = agentEvent('S1', { full: 'connection refused' })
    agentEvent('S1', { full: 'connection established' })
    agentEvent('S2', { full: 'connection refused' })
    const result = executeEventQuery({
      parsed: query([{ field: 'session', value: 'S1' }], 'refused')
    })
    expect(ids(result)).toEqual([both])
  })
})

describeDB('query conditions — tool-use IDs are session-scoped (T003)', () => {
  withTempDb('query-tool')

  function seedToolUse(sessionId: string, toolUseId: string): [string, string] {
    const call = seed('agent', {
      subtype: 'tool_call', session_id: sessionId, tool_use_id: toolUseId, tool_name: 'bash'
    })
    const result = seed('agent', {
      subtype: 'tool_result', session_id: sessionId, tool_use_id: toolUseId, output: 'ok'
    })
    return [call, result]
  }

  it('returns both halves of the exchange within one session', () => {
    const [call, res] = seedToolUse('S1', 'T7')
    const result = executeEventQuery({ parsed: query([{ field: 'tool', value: 'T7' }]) })
    expect(ids(result)).toEqual([call, res].sort())
  })

  it('resolves one session and names it when the ID exists in several', () => {
    seedToolUse('S1', 'T7')
    seedToolUse('S2', 'T7')
    const result = executeEventQuery({ parsed: query([{ field: 'tool', value: 'T7' }]) })

    expect(result.toolSession).toBeDefined()
    const chosen = result.toolSession!.sessionId
    expect(['S1', 'S2']).toContain(chosen)
    // The sessions not chosen are reported, so the operator can see the
    // narrowing happened and re-ask with an explicit session.
    expect(result.toolSession!.otherSessionIds).toEqual([chosen === 'S1' ? 'S2' : 'S1'])
    // Every returned event belongs to the one chosen session — a merged
    // result would pair a call from S1 with a result from S2.
    expect(result.items.every((e) => agentSessionOf(e) === chosen)).toBe(true)
    expect(result.items).toHaveLength(2)
  })

  it('honours an explicit session instead of choosing one', () => {
    seedToolUse('S1', 'T7')
    const [call2, res2] = seedToolUse('S2', 'T7')
    const result = executeEventQuery({
      parsed: query([
        { field: 'session', value: 'S2' },
        { field: 'tool', value: 'T7' }
      ])
    })
    expect(ids(result)).toEqual([call2, res2].sort())
    expect(result.toolSession?.otherSessionIds ?? []).toEqual([])
  })

  it('reports no competing sessions when the tool-use ID is unique', () => {
    seedToolUse('S1', 'T7')
    const result = executeEventQuery({ parsed: query([{ field: 'tool', value: 'T7' }]) })
    expect(result.toolSession?.otherSessionIds ?? []).toEqual([])
  })
})

describeDB('query conditions — a condition is not a text match (T004)', () => {
  withTempDb('query-notext')

  it('does not match an agent session ID merely quoted in another event', () => {
    const real = agentEvent('S-real')
    // An operator pasting a session ID into a command leaves it inside `data`,
    // where FTS indexes it. It is not evidence of that session.
    agentEvent('S-other', { full: 'grep S-real /var/log/app' })
    const result = executeEventQuery({ parsed: query([{ field: 'session', value: 'S-real' }]) })
    expect(ids(result)).toEqual([real])
  })

  it('does not match an event ID quoted in another event', () => {
    const real = agentEvent('S1')
    agentEvent('S1', { full: `see ${real} for context` })
    const result = executeEventQuery({ parsed: query([{ field: 'event', value: real }]) })
    expect(ids(result)).toEqual([real])
  })

  it('does not match a tool-use ID quoted in unrelated output', () => {
    const call = seed('agent', {
      subtype: 'tool_call', session_id: 'S1', tool_use_id: 'T9', tool_name: 'bash'
    })
    agentEvent('S1', { full: 'retrying T9 after timeout' })
    const result = executeEventQuery({ parsed: query([{ field: 'tool', value: 'T9' }]) })
    expect(ids(result)).toEqual([call])
  })

  it('still finds the same value as free text when asked for text', () => {
    agentEvent('S-real')
    const quoted = agentEvent('S-other', { full: 'grep S-real /var/log/app' })
    const result = executeEventQuery({ parsed: query([], 'S-real') })
    expect(ids(result)).toContain(quoted)
  })
})
