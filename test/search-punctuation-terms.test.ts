// A pasted command line is the most common query: `cat /etc/passwd | grep
// root`. Each term must match on its own (an event matches when every term is
// somewhere in it), and a term the tokenizer reads as no token at all — `|`,
// `&&`, `>`, `--`, `:` — would match nothing on its own and empty the result.
// Such a term says nothing about the text and is left out; a query made only
// of them matches nothing, as it always has.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requires } from './helpers/requires'
import { parseQuery } from '../src/core/query/contract'
import { ftsTerms } from '../src/core/query/fts-match'

const sqlite = requires('better-sqlite3')
let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let getDB: typeof import('../src/core/db').getDB
let queries: typeof import('../src/core/db/event-queries')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  const db = await import('../src/core/db')
  initDB = db.initDB; closeDB = db.closeDB; getDB = db.getDB
  queries = await import('../src/core/db/event-queries')
  idx = await import('../src/core/http-body-index')
}

const LINE = 'cat /etc/passwd | grep root && echo done > out.txt'
let dir = ''

function seed(): { chained: string; logged: string; body: string } {
  const db = getDB()
  db.prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
    VALUES ('chained',1,'p','s','o','shell','command_end','h',?,1,'hash')`).run(JSON.stringify({ subtype: 'command_end', command: LINE }))
  db.prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES ('logged',2,'p','s','o','scanner','http_request','h',?,2)`).run(JSON.stringify({ subtype: 'http_request', url: 'http://t.test/run', note: LINE }))
  // The words only in a saved body: found through the body index.
  const text = `{"cmd":"${LINE}"}`, sha256 = createHash('sha256').update(text).digest('hex')
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'http-bodies', `${sha256}.body`), text)
  db.prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES ('body',3,'p','s','o','scanner','http_response','h',?,3)`).run(JSON.stringify({ subtype: 'http_response', url: 'http://t.test/out',
    response_body_ref: { sha256, file: `${sha256}.body`, size: Buffer.byteLength(text), encoding: 'text' } }))
  return { chained: 'chained', logged: 'logged', body: 'body' }
}
function parsed(text: string) {
  const outcome = parseQuery(text)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.parsed
}
const ALL = ['body', 'chained', 'logged']
/** What every surface answers: the page, the count, and the dim/admit check. */
function answers(text: string): { items: string[]; count: number; matched: string[]; coverage: string | undefined } {
  const q = parsed(text)
  const page = queries.executeEventQuery({ parsed: q, filter: {}, limit: 50 })
  return {
    items: page.items.map(e => e.id).sort(),
    count: queries.countEvents({ parsed: q, filter: {} }),
    matched: queries.matchEventIds({ parsed: q, filter: {}, ids: ALL }).sort(),
    coverage: page.bodyCoverage?.sources?.find(s => s.kind === 'body')?.status,
  }
}

sqlite.describe('per-term matching of a pasted command line', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-punct-')); initDB(dir) })
  afterEach(() => { idx.closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  it.each([
    'cat /etc/passwd | grep root',
    'grep root && echo',
    'echo done > out',
    'cat -- passwd',
    'cat : passwd',
  ])('%s finds the event in either tier and in a saved body', text => {
    seed()
    expect(answers(text)).toEqual({ items: ALL, count: 3, matched: ALL, coverage: 'covered' })
  })

  it.each(['root&&echo', '--passwd', 'out.txt', 'passwd|grep'])('punctuation glued to a word still counts: %s', text => {
    seed()
    expect(answers(text)).toEqual({ items: ALL, count: 3, matched: ALL, coverage: 'covered' })
  })

  it.each(['|', '| && >', '-- :'])('a query of punctuation alone (%s) matches nothing, as before per-term matching', text => {
    seed()
    expect(answers(text)).toMatchObject({ items: [], count: 0, matched: [] })
  })
})

it('drops only the terms without a token, and keeps the prefix where the typing is', () => {
  expect(ftsTerms('cat /etc/passwd | grep')).toEqual(['"cat"', '"/etc/passwd"', '"grep"*'])
  // The operator is past `passwd`: it stays a whole word, as it always was.
  expect(ftsTerms('cat /etc/passwd |')).toEqual(['"cat"', '"/etc/passwd"'])
  expect(ftsTerms('a|b --x root&&echo')).toEqual(['"a|b"', '"--x"', '"root&&echo"*'])
  expect(ftsTerms('| && >')).toEqual(['"|"', '"&&"', '">"*'])
  // Underscore is a separator to unicode61; letters of any script are tokens.
  expect(ftsTerms('_ 中文')).toEqual(['"中文"*'])
  // Outside ASCII the tokenizer itself is asked, not the runtime's Unicode
  // tables: a symbol and a lone combining mark have no token; an accented
  // letter has one, and so, to unicode61, has an astral emoji.
  expect(ftsTerms('cat ¦ 🙂 \u0301 é')).toEqual(['"cat"', '"🙂"', '"é"*'])
})
