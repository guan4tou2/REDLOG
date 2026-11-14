// Counting what the body index does, and writing the rows it reads, for the
// body-index work tests. Rows go straight into the tables (the events FTS
// triggers still run), as test/helpers/body-search-project.ts writes them.
import { vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDB } from '../../src/core/db/index'
import { _inlineRefWork } from '../../src/core/http-body-index'
import { parseQuery } from '../../src/core/query/contract'

export function parsed(text: string) {
  const outcome = parseQuery(text)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.parsed
}

/** Source rows the body index reads (each a JSON parse and a link), and
 *  inline bodies it scans for escapes, during `run`. */
export function cost<T>(run: () => T): { rows: number; inline: number; result: T } {
  let rows = 0
  const prepare = Database.prototype.prepare
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
    const s = prepare.call(this, text)
    if (/^SELECT id,data,agent_type/.test(text)) {
      const iterate = s.iterate.bind(s), get = s.get.bind(s)
      ;(s as unknown as { iterate: (...a: unknown[]) => unknown }).iterate = function* (...a: unknown[]) { for (const r of iterate(...a)) { rows++; yield r } }
      ;(s as unknown as { get: (...a: unknown[]) => unknown }).get = (...a: unknown[]) => { const r = get(...a); if (r) rows++; return r }
    }
    return s
  })
  const inline = _inlineRefWork()
  try {
    const result = run()
    return { rows, inline: _inlineRefWork() - inline, result }
  } finally { spy.mockRestore() }
}

export const escapeNonAscii = (text: string): string => text.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

export function shellRow(id: string): void {
  getDB().prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
    VALUES (?,9000000,'project','capture','operator','shell','command_end','host',?,9000000,'hash')`).run(id, JSON.stringify({ subtype: 'command_end', command: 'id', stdout: 'uid=0' }))
}
/** A response whose inline body holds `word` and an escaped non-ASCII word. */
export function escapedResponse(id: string, word: string): void {
  const text = escapeNonAscii(JSON.stringify({ note: `${word} 新詞` }))
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,9000001,'project','capture','operator','scanner','http_response','host',?,9000001)`).run(id, JSON.stringify({
    subtype: 'http_response', url: 'http://new.test/', response_body: { data: text, encoding: 'text', size: Buffer.byteLength(text), truncated: false, content_type: 'application/json' } }))
}
export function savedBody(dir: string, text: string): { sha256: string; file: string; size: number; encoding: 'text' } {
  const sha256 = createHash('sha256').update(text).digest('hex'), file = `${sha256}.body`
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'http-bodies', file), text)
  return { sha256, file, size: Buffer.byteLength(text), encoding: 'text' }
}
export function savedResponse(id: string, data: Record<string, unknown>): void {
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,9000002,'project','capture','operator','scanner','http_response','host',?,9000002)`).run(id, JSON.stringify({ subtype: 'http_response', url: 'http://new.test/', ...data }))
}
export const bodySource = (page: { bodyCoverage?: { sources?: Array<{ kind: string; status: string; indexed: number }> } }) =>
  page.bodyCoverage?.sources?.find(s => s.kind === 'body')
