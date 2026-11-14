import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  parseJsonObjectBody, parseRecordingAction, parseLimitParam, parseTimeParam, jsonDepthExceeds,
  MAX_JSON_DEPTH, BODY_INVALID, BODY_NOT_OBJECT, BODY_TOO_DEEP, API_LIMITS
} from '../src/core/api-request'

// The request shapes the loopback API accepts, checked without a port (this
// sandbox refuses `listen`). Each case is one a probe of a running instance
// got a wrong answer for: a 500 carrying internal error text, a junk row
// stored with a 201, or recording state flipped by a body that named nothing.

describe('JSON route bodies', () => {
  it.each([
    ['null', BODY_NOT_OBJECT],
    ['[]', BODY_NOT_OBJECT],
    ['[{"title":"x"}]', BODY_NOT_OBJECT],
    ['"a string"', BODY_NOT_OBJECT],
    ['42', BODY_NOT_OBJECT],
    ['true', BODY_NOT_OBJECT],
    ['', BODY_INVALID],
    ['{not json', BODY_INVALID]
  ])('refuses %j with a fixed message', (raw, error) => {
    expect(parseJsonObjectBody(raw)).toEqual({ ok: false, error })
  })

  it('accepts a plain object', () => {
    expect(parseJsonObjectBody('{"agent_type":"shell","data":{"a":[1,{"b":2}]}}')).toEqual({
      ok: true, body: { agent_type: 'shell', data: { a: [1, { b: 2 }] } }
    })
  })

  it('refuses a body nested 10 000 levels deep before parsing it', () => {
    const deep = '{"a":'.repeat(10_000) + '1' + '}'.repeat(10_000)
    expect(parseJsonObjectBody(deep)).toEqual({ ok: false, error: BODY_TOO_DEEP })
    const deepArray = '['.repeat(10_000) + ']'.repeat(10_000)
    expect(parseJsonObjectBody(deepArray)).toEqual({ ok: false, error: BODY_TOO_DEEP })
  })

  // Only the event route asks for this (Spec 071 FR-097): the gate is on by
  // default, and an explicit `true` is the default.
  it('`depthGate: false` parses a 10 000-level object; the default and `true` refuse it', () => {
    const deep = '{"data":' + '{"a":'.repeat(10_000) + '1' + '}'.repeat(10_000) + '}'
    const r = parseJsonObjectBody(deep, { depthGate: false })
    expect(r.ok).toBe(true)
    expect(parseJsonObjectBody(deep, { depthGate: true })).toEqual({ ok: false, error: BODY_TOO_DEEP })
    expect(parseJsonObjectBody(deep, {})).toEqual({ ok: false, error: BODY_TOO_DEEP })
    expect(parseJsonObjectBody('null', { depthGate: false })).toEqual({ ok: false, error: BODY_NOT_OBJECT })
  })

  it('counts depth structurally, not brackets inside strings', () => {
    const nested = (n: number): string => '{"a":'.repeat(n - 1) + '{}' + '}'.repeat(n - 1)
    expect(jsonDepthExceeds(nested(MAX_JSON_DEPTH))).toBe(false)
    expect(jsonDepthExceeds(nested(MAX_JSON_DEPTH + 1))).toBe(true)
    const brackets = JSON.stringify({ text: '{'.repeat(5000) + '[\\"'.repeat(100) })
    expect(parseJsonObjectBody(brackets).ok).toBe(true)
  })

  it('every body-reading route in api-server goes through the one gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'api-server.ts'), 'utf-8')
    // The pattern each route used to repeat, which let null/arrays through.
    expect(src).not.toMatch(/JSON\.parse\(await readBody/)
    // And no 500 hands the thrown message to the client.
    expect(src).not.toMatch(/json\(res, 500, \{ error: \((?:e|err) as Error\)\.message/)
  })
})

describe('POST /api/recording action', () => {
  it.each(['pause', 'resume', 'toggle'] as const)('accepts %s', (action) => {
    expect(parseRecordingAction({ action })).toBe(action)
  })

  it.each([{}, { action: '' }, { action: 'stop' }, { action: 1 }, { action: null }, { Action: 'pause' }])(
    'refuses %j — nothing may change recording without naming how', (body) => {
      expect(parseRecordingAction(body as Record<string, unknown>)).toBeNull()
    })
})

describe('limit query parameters', () => {
  const { fallback, max } = API_LIMITS.events
  it('absent is the default', () => {
    expect(parseLimitParam(null, 'limit', fallback, max)).toEqual({ ok: true, value: fallback })
  })
  it('a positive integer is itself, clamped to the maximum', () => {
    expect(parseLimitParam('5', 'limit', fallback, max)).toEqual({ ok: true, value: 5 })
    expect(parseLimitParam(String(max), 'limit', fallback, max)).toEqual({ ok: true, value: max })
    expect(parseLimitParam('99999999999999999999', 'limit', fallback, max)).toEqual({ ok: true, value: max })
  })
  it.each(['-1', '0', '1.5', 'abc', '10abc', ' 5', '1e3', 'NaN', 'Infinity'])('%j is a 400 — -1 is "no limit" to SQLite', (raw) => {
    expect(parseLimitParam(raw, 'limit', fallback, max).ok).toBe(false)
  })
  it('every route has a documented maximum no larger than its old default reach', () => {
    for (const l of Object.values(API_LIMITS)) {
      expect(l.fallback).toBeLessThanOrEqual(l.max)
      expect(l.max).toBeGreaterThan(0)
    }
  })
})

describe('timestamp query parameters', () => {
  it('absent is no bound; digits are milliseconds', () => {
    expect(parseTimeParam(null, 'since')).toEqual({ ok: true, value: undefined })
    expect(parseTimeParam('1700000000000', 'since')).toEqual({ ok: true, value: 1700000000000 })
  })
  it.each(['-1', 'abc', '1.5', '12abc'])('%j is a 400, not NaN reaching the query', (raw) => {
    expect(parseTimeParam(raw, 'since').ok).toBe(false)
  })
})
