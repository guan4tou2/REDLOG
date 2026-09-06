import { describe, it, expect, afterEach } from 'vitest'
import {
  resolvePath, applyMapper, mapRaw, registerMappers, _resetMappers, type MapperSpec
} from '../src/core/mappers'

afterEach(() => _resetMappers())

describe('resolvePath', () => {
  const root = { a: { b: [{ c: 1 }, { c: 2 }] }, x: 'y', arr: [10, 20, 30] }
  it('walks dotted paths', () => expect(resolvePath(root, '$.x')).toBe('y'))
  it('walks array indexes', () => expect(resolvePath(root, '$.a.b[1].c')).toBe(2))
  it('walks bare array index', () => expect(resolvePath(root, '$.arr[2]')).toBe(30))
  it('returns the root for $.', () => expect(resolvePath(root, '$.')).toBe(root))
  it('is undefined on a missing hop, never throws', () => {
    expect(resolvePath(root, '$.a.z.c')).toBeUndefined()
    expect(resolvePath(root, '$.nope[4].x')).toBeUndefined()
  })
})

describe('applyMapper', () => {
  const spec: MapperSpec = {
    id: 'demo', version: '1', agentType: 'scanner',
    fields: {
      dest_host: '$.host',
      dest_port: '$.conn.port',
      description: ['$.summary', '=no summary'],
      proto: '=tcp'
    },
    tsSource: '$.ts'
  }

  it('pulls fields by path, applies literals and first-of fallback', () => {
    const raw = { host: '10.0.0.5', conn: { port: 445 }, ts: 1_700_000_000_000, extra_field: 'keep me' }
    const m = applyMapper(spec, raw)
    expect(m.agentType).toBe('scanner')
    expect(m.data.dest_host).toBe('10.0.0.5')
    expect(m.data.dest_port).toBe(445)
    expect(m.data.description).toBe('no summary') // summary absent → literal fallback
    expect(m.data.proto).toBe('tcp')
    expect(m.tsSource).toBe(1_700_000_000_000)
  })

  it('keeps unconsumed top-level keys under extra (no data is silently dropped)', () => {
    const raw = { host: 'h', conn: { port: 1 }, ts: 1, mystery: { deep: true }, note: 'n' }
    const m = applyMapper(spec, raw)
    expect(m.data.extra).toEqual({ mystery: { deep: true }, note: 'n' })
  })

  it('omits extra when keepExtra is false', () => {
    const m = applyMapper({ ...spec, keepExtra: false }, { host: 'h', junk: 1 })
    expect(m.data.extra).toBeUndefined()
  })

  it('treats a seconds timestamp as seconds and ms as ms', () => {
    const secs = applyMapper(spec, { host: 'h', conn: {}, ts: 1_700_000_000 })
    expect(secs.tsSource).toBe(1_700_000_000_000)
    const ms = applyMapper(spec, { host: 'h', conn: {}, ts: 1_700_000_000_000 })
    expect(ms.tsSource).toBe(1_700_000_000_000)
  })

  it('parses an ISO-8601 source timestamp, drops garbage', () => {
    expect(applyMapper(spec, { ts: '2024-01-02T03:04:05Z' }).tsSource).toBe(Date.parse('2024-01-02T03:04:05Z'))
    expect(applyMapper(spec, { ts: 'not a date' }).tsSource).toBeNull()
  })

  it('resolves agentType from a path when the spec asks for one', () => {
    const m = applyMapper({ id: 'p', version: '1', agentType: '$.kind', fields: {} }, { kind: 'dns', q: 'x' })
    expect(m.agentType).toBe('dns')
  })

  it('throws only when no agent_type can be named', () => {
    expect(() => applyMapper({ id: 'p', version: '1', agentType: '$.kind', fields: {} }, {})).toThrow()
  })
})

describe('mapRaw', () => {
  it('identity mapper is the current /api/events shape: agent_type + data pass through', () => {
    const r = mapRaw('identity', { agent_type: 'shell', data: { command: 'ls', subtype: 'command_start' }, timestamp: 1_700_000_000_000 })
    expect(r.agentType).toBe('shell')
    expect(r.data).toEqual({ command: 'ls', subtype: 'command_start' })
    expect(r.tsSource).toBe(1_700_000_000_000)
    expect(r.mapper).toEqual({ id: 'identity', version: '1' })
  })

  it('identity defaults agent_type to external and data to {}', () => {
    const r = mapRaw('identity', {})
    expect(r.agentType).toBe('external')
    expect(r.data).toEqual({})
  })

  it('a registered mapper is looked up by id and stamps its version', () => {
    registerMappers('p1', [{ id: 'sliver', version: '2', agentType: 'scanner', fields: { dest_host: '$.host' } }])
    const r = mapRaw('sliver', { host: 'beacon.evil' })
    expect(r.agentType).toBe('scanner')
    expect(r.data.dest_host).toBe('beacon.evil')
    expect(r.mapper).toEqual({ id: 'sliver', version: '2' })
  })

  it('unregistering a plugin removes its mappers', () => {
    registerMappers('p1', [{ id: 'x', version: '1', agentType: 'scanner', fields: {} }])
    _resetMappers()
    expect(() => mapRaw('x', {})).toThrow(/unknown mapper/)
  })
})
