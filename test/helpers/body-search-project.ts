// A project shaped like a real capture for body-search work: chained shell
// rows, logged HTTP requests, responses with ~4 KB inline JSON bodies (a third
// of them written with \uXXXX escapes) and responses whose saved body is gone.
// Rows are written straight into the tables in one transaction (Windows CI is
// slow on a commit per row); the events FTS triggers still run.
import { createHash } from 'node:crypto'
import { getDB } from '../../src/core/db/index'

export interface ProjectShape { shell: number; responses: number; escapedEvery: number; missing: number; rareEvery: number }
/** The shape the review measured: about 200k rows. */
export const LARGE_SHAPE: ProjectShape = { shell: 66_000, responses: 67_000, escapedEvery: 3, missing: 1_000, rareEvery: 6_700 }

const escapeAll = (text: string): string => text.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** A ~4 KB JSON body; `n` picks its words. */
export function responseBody(n: number, shape: ProjectShape): string {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: n * 100 + i, name: `項目${i}`, note: 'common words fill this body' }))
  const text = JSON.stringify({ n, items, ...(n % shape.rareEvery === 0 ? { tag: 'RAREBODYWORD 稀有詞' } : {}) })
  return n % shape.escapedEvery === 0 ? escapeAll(text) : text
}

export function seedBodySearchProject(shape: ProjectShape): { missingIds: string[]; escaped: number } {
  const db = getDB()
  const chained = db.prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
    VALUES (?,?,'project','capture','operator','shell','command_end','host',?,?,'hash')`)
  const logged = db.prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,?,'project','capture','operator','scanner',?,'host',?,?)`)
  const missingIds: string[] = []
  let escaped = 0
  db.transaction(() => {
    for (let i = 0; i < shape.shell; i++)
      chained.run(`shell-${i}`, 1_000 + i, JSON.stringify({ subtype: 'command_end', command: `nmap -sV 10.0.${i % 250}.1`, stdout: 'common output line' }), 1_000 + i)
    for (let i = 0; i < shape.responses; i++) {
      const url = `http://api${i % 50}.test/v1/items/${i}?urltoken${i % 7}`
      logged.run(`req-${i}`, 2_000_000 + 2 * i, 'http_request_start', JSON.stringify({ subtype: 'http_request_start', flow_id: `f${i}`, method: 'GET', url, host: `api${i % 50}.test` }), 2_000_000 + 2 * i)
      let data: Record<string, unknown>
      if (i < shape.missing) {
        const sha256 = createHash('sha256').update(`gone-${i}`).digest('hex')
        data = { response_body_ref: { sha256, file: `${sha256}.body`, size: 8192, encoding: 'text' } }
        missingIds.push(`res-${i}`)
      } else {
        const text = responseBody(i, shape)
        if (text.includes('\\u')) escaped++
        data = { response_body: { data: text, encoding: 'text', size: Buffer.byteLength(text), sha256: '', truncated: false, content_type: 'application/json' }, response_preview: text }
      }
      logged.run(`res-${i}`, 2_000_001 + 2 * i, 'http_response', JSON.stringify({ subtype: 'http_response', flow_id: `f${i}`, url, status: 200, content_type: 'application/json', ...data }), 2_000_001 + 2 * i)
    }
  })()
  return { missingIds, escaped }
}
