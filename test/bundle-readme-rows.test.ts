// The bundle README tells a recipient how to read a row nested past 64 levels,
// and what the verifier's receiver-provenance counts mean
// (src/core/bundle-readme-rows.ts). They have only the README, so what it says
// must be what the writer does: its worked examples are produced by the code,
// and its reading rule, followed literally, gives what restoreDataDepth gives.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROW_ADDITIONS_README } from '../src/core/bundle-readme-rows'
import { receiverProvenance, type ProvenanceCounts } from '../src/core/evidence-rules'
import { VERIFIER } from './fixtures/golden-pre071-generate'
import { COLLAPSED_KEY, boundDataDepth, restoreDataDepth } from '../src/core/ingest/depth'

const README = ROW_ADDITIONS_README.join('\n')

/** The README's fenced blocks, in order, as lists of lines. */
function blocks(): string[][] {
  const out: string[][] = []
  let open: string[] | null = null
  for (const line of ROW_ADDITIONS_README) {
    if (line === '```') { if (open) { out.push(open); open = null } else open = []; continue }
    if (open) open.push(line)
  }
  return out
}

/** `data` holding `inner` (JSON text) at level 64: data (1) → d (2) → 62 arrays → level 64. */
const at64 = (inner: string): Record<string, unknown> =>
  JSON.parse(`{"subtype":"x","d":${'['.repeat(62)}${inner}${']'.repeat(62)}}`) as Record<string, unknown>
const nodeAt64 = (data: Record<string, unknown>): unknown => {
  let v: unknown = data.d
  for (let level = 2; level < 64; level++) v = (v as unknown[])[0]
  return v
}

/** The README's reading rule, followed literally and nothing more. */
function readAsReadmeSays(stored: Record<string, unknown>): unknown {
  const isWrapper = (v: unknown): v is Record<string, string> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 &&
    Object.keys(v)[0] === '_collapsed' && typeof (v as Record<string, unknown>)._collapsed === 'string'
  const copy = (v: unknown, level: number): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (level === 64) return isWrapper(v) ? JSON.parse(v._collapsed) : v
    if (Array.isArray(v)) return v.map((x) => copy(x, level + 1))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, level + 1)]))
  }
  return copy(stored, 1)
}

describe('the bundle README on rows nested past 64 levels (FR-097)', () => {
  it('its worked examples are what the writer stores, and read back to the value sent', () => {
    const [sent, stored] = blocks()
    expect(sent.length).toBe(2)
    expect(stored.length).toBe(sent.length)
    sent.forEach((input, i) => {
      const { data, collapsed } = boundDataDepth(at64(input))
      expect(collapsed, input).toBe(1)
      expect(JSON.stringify(nodeAt64(data)), input).toBe(stored[i])
      expect(JSON.stringify(nodeAt64(restoreDataDepth(data)))).toBe(JSON.stringify(JSON.parse(input)))
      expect(JSON.stringify(readAsReadmeSays(data))).toBe(JSON.stringify(restoreDataDepth(data)))
    })
    // What it says is lost is lost: the first "a", the spellings.
    expect(stored[0]).not.toContain('1.0')
    expect(stored[1]).not.toContain('"a\\":1')
  })

  it('its reading rule gives what restoreDataDepth gives, a sender\'s look-alikes at other levels and at 64 included', () => {
    const lookAlike = JSON.stringify({ [COLLAPSED_KEY]: '[[1]]' })
    const cases = [
      `{"subtype":"x","shallow":${lookAlike},"d":${'['.repeat(62)}${lookAlike}${']'.repeat(62)}}`,
      `{"subtype":"x","d":${'['.repeat(60)}${lookAlike}${']'.repeat(60)}}`,
      `{"subtype":"x","d":${'['.repeat(70)}${lookAlike}${']'.repeat(70)}}`,
      `{"subtype":"x","d":${'['.repeat(62)}[[2],{"k":[3]},"s",${lookAlike}]${']'.repeat(62)}}`
    ]
    for (const text of cases) {
      const sent = JSON.parse(text) as Record<string, unknown>
      const { data } = boundDataDepth(sent)
      expect(JSON.stringify(readAsReadmeSays(data)), text.slice(0, 60)).toBe(JSON.stringify(restoreDataDepth(data)))
      expect(JSON.stringify(readAsReadmeSays(data))).toBe(JSON.stringify(sent))
    }
  })

  it('states the rule whole: level 1 is data, wrappers only at 64, look-alikes elsewhere are the sender\'s, and at 64 there are no exceptions', () => {
    const prose = README.replace(/\s+/g, ' ')
    expect(prose).toContain('`data` itself counting as level 1')
    expect(prose).toContain('at level 64, and only there')
    expect(prose).toContain('An object of that shape at any other level is the sender\'s own')
    expect(prose).toContain('at level 64 the rule has no exceptions')
    expect(prose).not.toMatch(/byte for byte/)
  })
})

// The README's three receiver-provenance states (FR-022–024), followed
// literally, give what receiverProvenance gives on every shared rule vector,
// and use the labels tools/redlog-verify.py prints.
describe('the bundle README on receiver provenance', () => {
  interface VectorRow { tier: 'chained' | 'logged'; hashChecked: boolean; session_id: unknown; agent_type: unknown; data: unknown }
  const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'provenance-rule-vectors.json'), 'utf8')) as
    { cases: Array<{ name: string; rows: VectorRow[] }> }
  const prose = README.replace(/\s+/g, ' ')

  /** The README's three bullets, read literally. "carries `_ingest`": an
   *  object there, the stamp the README describes above. */
  function countAsReadmeSays(rows: VectorRow[]): ProvenanceCounts {
    const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
    const carries = (r: VectorRow): boolean => obj(r.data) && obj(r.data._ingest)
    const isStart = (r: VectorRow): boolean => r.tier === 'chained' && r.agent_type === 'system' && obj(r.data) && r.data.subtype === 'session_start'
    const out: ProvenanceCounts = { chained: { proven: 0, selfDescribed: 0, undetermined: 0 }, logged: { selfDescribed: 0, stamped: 0, undetermined: 0 } }
    for (const r of rows) {
      const starts = rows.filter((s) => isStart(s) && typeof r.session_id === 'string' && s.session_id === r.session_id)
      if (starts.length === 0) { (r.tier === 'logged' ? out.logged : out.chained).undetermined++; continue }
      if (r.tier === 'logged') { out.logged.selfDescribed++; if (carries(r)) out.logged.stamped++; continue }
      const proven = carries(r) && r.hashChecked && starts.every((s) => carries(s) && s.hashChecked)
      if (proven) out.chained.proven++
      else out.chained.selfDescribed++
    }
    return out
  }

  it('its three states, followed literally, count what the verifiers count on every rule vector', () => {
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const rows = c.rows.map((r) => ({ tier: r.tier, hashChecked: r.hashChecked, sessionId: r.session_id, agentType: r.agent_type, data: r.data }))
      expect(countAsReadmeSays(c.rows), c.name).toEqual(receiverProvenance(rows))
    }
  })

  it('states each condition the rule has, with the labels the verifier prints', () => {
    for (const label of ['**proven**', '**self-described**', '**cannot be determined**']) expect(prose).toContain(label)
    expect(prose).toContain('session_start` rows in `events.jsonl` all carry it too, and the export transformed none of them')
    expect(prose).toContain('every row of `events_logged.jsonl`, whose stamp is not protected row by row')
    expect(prose).toContain('a row the export transformed')
    expect(prose).toContain('`events.jsonl` holds no `session_start` of the row\'s `session_id`')
    expect(prose).toContain('The counts do not change the verdict or the exit code.')
    const py = fs.readFileSync(VERIFIER, 'utf8')
    for (const label of ['proven', 'self-described', 'cannot be determined']) expect(py).toContain(`${label}:`)
  })
})
