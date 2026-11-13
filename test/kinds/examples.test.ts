// Spec 072 T003 — the example rows cover exactly what the writers write.
//
// examples.ts is hand-written; the inventory (T002) is measured. This file is
// the bridge: a kind found by the scan with no example is a kind T004's
// golden files say nothing about, and an example for a kind nobody writes is a
// golden that pins an answer for nothing. Both fail, naming the kind.
//
// It also pins what the spec asks the set to contain, so a later edit cannot
// quietly drop the awkward rows: each relay completeness × output_disposition,
// the three built-in-terminal `io` states, a command_end with no completeness
// field, the old shell:command, an unregistered agent:* subtype, and the
// plugin kinds.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { scanInventory, kindIds } from './inventory'
import { ALL_KINDS, EXAMPLES, LEGACY } from './examples'

const ROOT = path.join(__dirname, '..', '..')
const found = kindIds(scanInventory(ROOT).hits)

describe('examples cover the inventory (Spec 072 T003)', () => {
  it('every kind a writer writes has an example row', () => {
    const have = new Set(EXAMPLES.map((e) => e.kind))
    expect(found.filter((k) => !have.has(k))).toEqual([])
  })

  it('every default example is a kind a writer writes', () => {
    const wrote = new Set(found)
    expect(ALL_KINDS.filter((k) => !wrote.has(k))).toEqual([])
  })

  it('example ids are unique and the row agrees with its kind', () => {
    const ids = EXAMPLES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of EXAMPLES) {
      const [agentType, subtype] = e.kind.split(':')
      expect(e.row.agentType, e.id).toBe(agentType)
      if (e.id === e.kind && subtype !== undefined) expect(e.row.data.subtype, e.id).toBe(subtype)
    }
  })

  it('rows are byte-stable: ids and times come from position only', () => {
    expect(EXAMPLES[0].row.id).toBe('ex-0001')
    expect(EXAMPLES.every((e) => e.row.timestamp >= 1_700_000_000_000 && e.row.timestamp < 1_700_100_000_000)).toBe(true)
    expect(JSON.stringify(EXAMPLES.map((e) => e.row))).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\|\/tmp\//)
  })

  it('names the legacy kinds that have a row but no writer', () => {
    for (const k of LEGACY) expect(EXAMPLES.some((e) => e.kind === k), k).toBe(true)
    expect(LEGACY.filter((k) => found.includes(k))).toEqual([])
  })
})

describe('examples contain the rows the spec names', () => {
  const ends = EXAMPLES.filter((e) => e.kind === 'shell:command_end')
  const pair = (e: (typeof ends)[number]): string => `${String(e.row.data.completeness)}/${String(e.row.data.output_disposition)}`

  it('each completeness × output_disposition the relay and redlog-run write', () => {
    const got = new Set(ends.map(pair))
    for (const want of ['complete/captured', 'truncated/captured', 'partial/captured', 'metadata-only/redirected', 'metadata-only/not-captured']) {
      expect(got.has(want), want).toBe(true)
    }
  })

  it('the three built-in-terminal io states', () => {
    const io = ends.map((e) => e.row.data.io as { len?: number; unbracketed?: boolean } | undefined).filter(Boolean)
    expect(io.some((x) => (x!.len ?? 0) > 0 && !x!.unbracketed)).toBe(true)
    expect(io.some((x) => x!.len === 0)).toBe(true)
    expect(io.some((x) => x!.unbracketed === true)).toBe(true)
  })

  it('a command_end with none of the producer-statement fields', () => {
    expect(ends.some((e) => !('completeness' in e.row.data) && !('output_disposition' in e.row.data) && !('captured_by' in e.row.data))).toBe(true)
  })

  it('shell:command, an unregistered agent:* subtype, the pcap and c2 plugin kinds', () => {
    const has = (k: string): boolean => EXAMPLES.some((e) => e.kind === k)
    for (const k of ['shell:command', 'agent:future_subtype', 'scanner:packet_flow', 'scanner:pcap_segment', 'scanner:c2_checkin', 'scanner:c2_task', 'scanner:c2_pivot']) expect(has(k), k).toBe(true)
  })
})
