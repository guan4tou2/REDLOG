// "Find in content" finds a word in a body that a JSON encoder wrote as
// `\uXXXX` escapes, where body search already finds it: the match is the
// escaped run as saved, which is what the Reader shows and highlights.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { describeEventContent, readEventContent, findEventContent } from '../src/core/evidence-content'
import type { ContentFindCursor, ContentRef } from '../src/core/content-contract'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-find-decoded-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

function event(id: string, data: Record<string, unknown>, agentType = 'scanner', subtype = 'http_response'): void {
  getDB().prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash) VALUES (?,1,'project','capture','operator',?,?,'host',?,1,'hash')`).run(id, agentType, subtype, JSON.stringify(data))
}
function saved(text: string) {
  const bytes = Buffer.from(text, 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex'), file = sha256 + '.body'
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'http-bodies', file), bytes)
  return { sha256, file, size: bytes.length, encoding: 'text' }
}
function refOf(id: string, field: string): ContentRef {
  const r = describeEventContent('project', id)
  if (!r.ok) throw new Error(r.message)
  const d = r.value.find(v => v.field === field)
  if (!d?.ref) throw new Error('fixture field absent')
  return d.ref
}
/** Every match from the start to the end, following the cursor. */
function walk(ref: ContentRef, needle: string): Array<{ offset: number; bytes: number }> {
  const out: Array<{ offset: number; bytes: number }> = []
  let cursor: ContentFindCursor | undefined
  for (let calls = 0; calls < 1000; calls++) {
    const r = findEventContent({ ref, needle, ...(cursor ? { cursor } : {}) })
    if (!r.ok) throw new Error(r.message)
    if (r.value.match) out.push(r.value.match)
    if (!r.value.nextCursor) return out
    cursor = r.value.nextCursor
  }
  throw new Error('find did not reach the end')
}
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const NAME = '\\u738b\\u5c0f\\u660e' // 王小明 as an encoder that escapes non-ASCII writes it

describe('find in content: decoded escapes', () => {
  it('finds 王小明 in a body saved as {"name":"\\u738b\\u5c0f\\u660e"}, as the escaped run', () => {
    const body = `{"name":"${NAME}"}`
    event('inline', { response_body: { data: body, encoding: 'text' } })
    const ref = refOf('inline', 'response_body')
    const r = findEventContent({ ref, needle: '王小明' })
    expect(r).toMatchObject({ ok: true, value: { match: { offset: 9, bytes: 18 } } })
    const w = readEventContent({ ref, offset: 9 })
    expect(w.ok && w.value.text.slice(0, 18)).toBe(NAME)
  })

  it('finds literal and escaped occurrences in order, each once, then nothing', () => {
    const a = 'head 王小明 and ', b = `${NAME} then `, text = `${a}${b}王小明.`
    event('both', { response_body_ref: saved(text) })
    expect(walk(refOf('both', 'response_body'), '王小明')).toEqual([
      { offset: bytes('head '), bytes: 9 },
      { offset: bytes(a), bytes: 18 },
      { offset: bytes(a + b), bytes: 9 }
    ])
  })

  it('matches a mix of literal and escaped characters', () => {
    const text = 'x 王\\u5c0f明 y'
    event('mixed', { response_body_ref: saved(text) })
    expect(walk(refOf('mixed', 'response_body'), '王小明')).toEqual([{ offset: 2, bytes: bytes('王\\u5c0f明') }])
  })

  it('still finds the escaped form typed as written', () => {
    event('typed', { response_body_ref: saved(`{"name":"${NAME}"}`) })
    expect(walk(refOf('typed', 'response_body'), '\\u738b')).toEqual([{ offset: 9, bytes: 6 }])
  })

  it('decodes only where body search decodes: command output keeps its escapes as written', () => {
    event('shell', { command: 'curl api', stdout: `{"name":"${NAME}"} C:\\users\\u0041` }, 'shell', 'command_end')
    const ref = refOf('shell', 'stdout')
    expect(walk(ref, '王小明')).toEqual([])
    expect(walk(ref, 'A')).toEqual([])
    expect(walk(ref, NAME)).toEqual([{ offset: 9, bytes: 18 }])
  })

  it('refuses a cursor from another needle and one issued under literal-only matching', () => {
    event('cursor', { response_body_ref: saved('x'.repeat(3 * 1024 * 1024)) })
    const ref = refOf('cursor', 'response_body')
    const first = findEventContent({ ref, needle: 'absent' })
    if (!first.ok || !first.value.nextCursor) throw new Error('expected a continuation')
    expect(findEventContent({ ref, needle: 'other', cursor: first.value.nextCursor })).toMatchObject({ ok: false, status: 'changed' })
    // The cursor the literal matcher issued: the needle's own digest, no resume point.
    const old = { version: ref.version, offset: first.value.nextCursor.offset, query: createHash('sha256').update(Buffer.from('absent')).digest('hex') }
    expect(findEventContent({ ref, needle: 'absent', cursor: old as ContentFindCursor })).toMatchObject({ ok: false, status: 'changed' })
  })

  // The real window (64 KiB) and scan budget (1 MiB): a call that stops at its
  // budget hands the next call a cursor, and an escape cut there must be
  // neither lost nor found twice.
  it.each([65536, 1024 * 1024])('finds an 18-byte escaped match at every alignment across byte %i', (boundary) => {
    for (let lead = 0; lead <= 18; lead++) {
      const id = `edge-${boundary}-${lead}`, start = boundary - lead
      event(id, { response_body_ref: saved('x'.repeat(start) + NAME + 'y'.repeat(40)) })
      expect(walk(refOf(id, 'response_body'), '王小明'), `match starting ${lead} bytes before ${boundary}`).toEqual([{ offset: start, bytes: 18 }])
    }
  })
})
