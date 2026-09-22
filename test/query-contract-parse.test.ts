// Spec 017 T001 — RED.
//
// These fail against the unimplemented `parseQuery` stub. They are written
// first because the parse is where a query's meaning is decided, and every
// later layer (field predicates, FTS, the Transcript's display of how it read
// the query) consumes its output. Each case below is a counterexample that a
// plausible-looking implementation gets wrong:
//
//   - splitting on ':' anywhere turns a pasted URL into a condition
//   - accepting any prefix as a field turns a typo into a silent no-match
//   - dropping unrecognised tokens loses search terms
//   - treating `session:` as text hides a half-typed condition
//
// Resolution semantics (what a condition matches) are T002-T004; this file is
// only about what the input means.

import { describe, expect, it } from 'vitest'
import { parseQuery, QUERY_FIELDS, type ParsedQuery } from '../src/core/query/contract'

function parsed(input: string): ParsedQuery {
  const outcome = parseQuery(input)
  if (!outcome.ok) throw new Error(`expected ${input} to parse, got ${outcome.reason}`)
  return outcome.parsed
}

describe('query parse — conditions', () => {
  it('reads every recognised field as a condition', () => {
    for (const field of QUERY_FIELDS) {
      const p = parsed(`${field}:abc123`)
      expect(p.conditions).toEqual([{ field, value: 'abc123' }])
      expect(p.text).toBe('')
    }
  })

  it('accepts a query that is only conditions', () => {
    const p = parsed('session:S1 tool:T7')
    expect(p.conditions).toEqual([
      { field: 'session', value: 'S1' },
      { field: 'tool', value: 'T7' }
    ])
    expect(p.text).toBe('')
  })

  it('keeps conditions and free text together', () => {
    const p = parsed('session:S1 timeout')
    expect(p.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(p.text).toBe('timeout')
  })

  it('preserves every free-text term, in order', () => {
    const p = parsed('connection refused session:S1 retry')
    expect(p.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(p.text).toBe('connection refused retry')
  })
})

describe('query parse — text that only looks like a condition', () => {
  it('leaves a pasted URL alone', () => {
    const p = parsed('https://example.com/a')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('https://example.com/a')
  })

  it('leaves an unrecognised field prefix as text', () => {
    const p = parsed('sesion:S1')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('sesion:S1')
  })

  it('leaves a host:port pair as text', () => {
    const p = parsed('10.0.0.5:8080')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('10.0.0.5:8080')
  })

  it('does not read a colon that starts a token as a field', () => {
    const p = parsed(':S1')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe(':S1')
  })

  it('reads only the first colon of a condition, so the value may contain one', () => {
    const p = parsed('event:evt:1')
    expect(p.conditions).toEqual([{ field: 'event', value: 'evt:1' }])
    expect(p.text).toBe('')
  })
})

describe('query parse — reporting how it read the input', () => {
  it('labels every token so a surface can show the parse', () => {
    const p = parsed('session:S1 sesion:S2 timeout')
    expect(p.tokens).toEqual([
      { raw: 'session:S1', read: 'condition' },
      { raw: 'sesion:S2', read: 'text' },
      { raw: 'timeout', read: 'text' }
    ])
  })

  it('reports tokens for a text-only query', () => {
    expect(parsed('timeout').tokens).toEqual([{ raw: 'timeout', read: 'text' }])
  })
})

describe('query parse — failure is distinct from an empty result', () => {
  it('rejects a recognised field with no value', () => {
    const outcome = parseQuery('session:')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('empty-condition-value')
    expect(outcome.token).toBe('session:')
  })

  it('names the offending token, not the whole query', () => {
    const outcome = parseQuery('timeout tool: retry')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.token).toBe('tool:')
  })

  it('treats an empty query as parsed and empty, not as a failure', () => {
    const p = parsed('   ')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('')
    expect(p.tokens).toEqual([])
  })
})

describe('query parse — writing a recognised prefix as text (FR-006)', () => {
  it('treats a quoted token as literal text', () => {
    const p = parsed('"event:evt-1"')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('event:evt-1')
  })

  it('keeps the quoted token beside a real condition', () => {
    const p = parsed('session:S1 "event:evt-1"')
    expect(p.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(p.text).toBe('event:evt-1')
  })

  it('reports a quoted token as text, not as a condition', () => {
    expect(parsed('"session:S1"').tokens).toEqual([{ raw: '"session:S1"', read: 'text' }])
  })

  it('allows whitespace inside a quoted token', () => {
    const p = parsed('"connection refused"')
    expect(p.conditions).toEqual([])
    expect(p.text).toBe('connection refused')
  })

  it('rejects an unterminated quote instead of guessing where it ends', () => {
    const outcome = parseQuery('"event:evt-1')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unterminated-quote')
  })
})

describe('query parse — field names ignore case (FR-007)', () => {
  it('recognises a field written in capitals', () => {
    const p = parsed('SESSION:S1')
    expect(p.conditions).toEqual([{ field: 'session', value: 'S1' }])
  })

  it('recognises a field written in mixed case', () => {
    expect(parsed('ToolUse:T7').conditions).toEqual([])
    expect(parsed('Tool:T7').conditions).toEqual([{ field: 'tool', value: 'T7' }])
  })

  it('leaves the condition value case alone', () => {
    expect(parsed('session:SESS-Alpha').conditions).toEqual([
      { field: 'session', value: 'SESS-Alpha' }
    ])
  })
})
