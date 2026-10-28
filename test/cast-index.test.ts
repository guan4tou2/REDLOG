import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// docs/DESIGN-core-and-capture.md §2.4. The claim being tested is not "rows
// land in a table" — it is that a hit points back at bytes the operator can
// actually read, which is the only thing that makes an unstructured `ssh`
// session findable rather than merely counted.

let mod: typeof import('../src/core/cast-index') | null = null
let slice: typeof import('../src/core/cast-slice') | null = null
try {
  // Importing is not the check — the native binding only loads on the first
  // `new Database`, so an import-only guard reports "available" and then
  // every test dies inside the module under test.
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  mod = await import('../src/core/cast-index')
  slice = await import('../src/core/cast-slice')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = mod !== null && slice !== null

/** Build an asciicast v2 file. `t0` is unix seconds. */
function writeCast(file: string, t0: number, frames: Array<[number, string]>): void {
  const lines = [JSON.stringify({ version: 2, width: 80, height: 24, timestamp: t0 })]
  for (const [rel, text] of frames) lines.push(JSON.stringify([rel, 'o', text]))
  fs.writeFileSync(file, lines.join('\n') + '\n')
}

describe.skipIf(!available)('cast full-text index', () => {
  let dir: string
  let castsDir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-castidx-'))
    castsDir = path.join(dir, 'casts')
    fs.mkdirSync(castsDir)
  })
  afterEach(() => {
    mod!.closeCastIndex()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cast = (name: string): string => path.join(castsDir, name)

  it('keeps a not-yet-complete first frame pending, then indexes its confirmed lines', async () => {
    fs.writeFileSync(cast('starting.cast'),'')
    await mod!.backfillCastIndex(dir)
    expect(mod!.castIndexStatus(dir)).toMatchObject({total:1,pending:1,failed:0})
    fs.writeFileSync(cast('starting.cast'),'{"version":2')
    await mod!.backfillCastIndex(dir)
    expect(mod!.castIndexStatus(dir)).toMatchObject({pending:1,failed:0})
    writeCast(cast('starting.cast'),1700000000,[[0.1,'STARTINGCANARY\r\n']])
    await mod!.backfillCastIndex(dir)
    expect(mod!.searchCasts('STARTINGCANARY',10,dir)).toHaveLength(1)
    expect(mod!.castIndexStatus(dir)).toMatchObject({indexed:1,pending:0,failed:0})
  })

  it('finds a port number in scan output', async () => {
    writeCast(cast('a.cast'), 1_700_000_000, [
      [0.1, 'nmap -sV 10.0.0.5\r\n'],
      [1.2, '445/tcp   open  microsoft-ds\r\n'],
      [1.3, '3389/tcp  open  ms-wbt-server\r\n']
    ])
    await mod!.indexCast(cast('a.cast'), dir)
    const hits = mod!.searchCasts('445', 10, dir)
    expect(hits.length).toBe(1)
    expect(hits[0].castRel).toBe('a.cast')
  })

  it('points at bytes that read back as the matching output', async () => {
    // The offsets are the whole point. A hit whose byte range does not
    // resolve is a search result the operator cannot open, which is worse
    // than no result — it says the evidence exists and then fails to produce
    // it.
    writeCast(cast('b.cast'), 1_700_000_000, [
      [0.1, 'uninteresting preamble\r\n'],
      [5.0, 'PWNED-MARKER-9182\r\n']
    ])
    await mod!.indexCast(cast('b.cast'), dir)
    const [hit] = mod!.searchCasts('PWNED-MARKER-9182', 10, dir)
    expect(hit, 'no hit to resolve').toBeTruthy()

    const read = await slice!.readCastRange(cast('b.cast'), hit.off, hit.len)
    expect(read).not.toBeNull()
    expect(read!.text).toContain('PWNED-MARKER-9182')
  })

  it('reports the wall-clock time of the match, not the offset into the cast', async () => {
    const t0 = 1_700_000_000
    writeCast(cast('c.cast'), t0, [[42.5, 'late line\r\n']])
    await mod!.indexCast(cast('c.cast'), dir)
    const [hit] = mod!.searchCasts('late', 10, dir)
    expect(hit.tMs).toBe(t0 * 1000 + 42_500)
  })

  it('strips ANSI before indexing', async () => {
    // Terminal output is full of escape sequences. Indexing them verbatim
    // means a colourised `open` does not match a search for open, which is
    // exactly the case an operator hits first.
    writeCast(cast('d.cast'), 1_700_000_000, [
      [0.1, '[32mopen[0m [1mfiltered[0m\r\n']
    ])
    await mod!.indexCast(cast('d.cast'), dir)
    expect(mod!.searchCasts('open', 10, dir).length).toBe(1)
    expect(mod!.searchCasts('filtered', 10, dir).length).toBe(1)
  })

  it('does not index resize geometry as terminal text', async () => {
    fs.writeFileSync(cast('resize.cast'), [
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000 }),
      JSON.stringify([0.1, 'o', 'visible output']),
      JSON.stringify([0.2, 'r', '120x40']),
      ''
    ].join('\n'))
    await mod!.indexCast(cast('resize.cast'), dir)
    expect(mod!.searchCasts('visible', 10, dir)).toHaveLength(1)
    expect(mod!.searchCasts('120x40', 10, dir)).toHaveLength(0)
  })

  it('treats punctuation as text, not as query syntax', async () => {
    // FTS5 MATCH reads bare `-` and `"` as operators. An operator searching
    // for `-sV` or an IP would otherwise get a syntax error or silence.
    writeCast(cast('e.cast'), 1_700_000_000, [
      [0.1, 'running nmap -sV against 10.0.0.5\r\n']
    ])
    await mod!.indexCast(cast('e.cast'), dir)
    expect(mod!.searchCasts('10.0.0.5', 10, dir).length).toBe(1)
    expect(mod!.searchCasts('-sV', 10, dir).length).toBe(1)
    expect(() => mod!.searchCasts('"', 10, dir)).not.toThrow()
    expect(() => mod!.searchCasts('AND OR NOT', 10, dir)).not.toThrow()
  })

  // Constitution VI. Every input is quoted into valid MATCH syntax (the test
  // above), so an error here is the index failing — and "no hits" would tell
  // the operator the recordings never contained the term.
  it('reports a failing index instead of answering no hits', async () => {
    writeCast(cast('g.cast'), 1_700_000_000, [[0.1, 'whoami\r\n']])
    await mod!.indexCast(cast('g.cast'), dir)
    mod!.getCastIndex(dir).exec('DROP TABLE cast_fts')
    expect(() => mod!.searchCasts('whoami', 10, dir)).toThrow()
  })

  it('prefix-matches the term still being typed', async () => {
    writeCast(cast('f.cast'), 1_700_000_000, [[0.1, 'gobuster dir -u http://x\r\n']])
    await mod!.indexCast(cast('f.cast'), dir)
    expect(mod!.searchCasts('gobus', 10, dir).length).toBe(1)
  })

  it('intersects query terms across chunks of one physical recording, never across unrelated files', async () => {
    writeCast(cast('terms.cast'),1_700_000_000,[[0.1,'FIRSTTERM '+ 'padding '.repeat(400)],[0.2,'LASTTERM\r\n']])
    writeCast(cast('first.cast'),1_700_000_000,[[0.1,'FIRSTTERM\r\n']])
    writeCast(cast('last.cast'),1_700_000_000,[[0.1,'LASTTERM\r\n']])
    await mod!.backfillCastIndex(dir)
    const hits=mod!.searchCasts('FIRSTTERM LASTTERM',10,dir)
    expect(hits.length).toBeGreaterThan(0)
    expect(new Set(hits.map(h=>h.castRel))).toEqual(new Set(['terms.cast']))
  })

  it('does not invent a word boundary when a long token spans output frames', async () => {
    writeCast(cast('token.cast'),1_700_000_000,[[0.1,'a'.repeat(1900)],[0.2,'SPLITTOKEN\r\n']])
    await mod!.indexCast(cast('token.cast'),dir)
    expect(mod!.searchCasts('SPLITTOKEN',10,dir)).toHaveLength(0)
  })

  it('skips a re-index when the recording has not changed', async () => {
    writeCast(cast('g.cast'), 1_700_000_000, [[0.1, 'hello world\r\n']])
    const first = await mod!.indexCast(cast('g.cast'), dir)
    expect(first.skipped).toBeNull()
    const second = await mod!.indexCast(cast('g.cast'), dir)
    expect(second.skipped).toBe('unchanged')
    expect(second.chunks).toBe(first.chunks)
    // And re-indexing has not doubled the hits.
    expect(mod!.searchCasts('hello', 10, dir).length).toBe(1)
  })

  it('invalidates a same-size rewrite before returning a stale hit', async () => {
    writeCast(cast('rewrite.cast'),1_700_000_000,[[0.1,'OLDMARKER']])
    await mod!.indexCast(cast('rewrite.cast'),dir)
    writeCast(cast('rewrite.cast'),1_700_000_000,[[0.1,'NEWMARKER']])
    expect(mod!.searchCasts('OLDMARKER',10,dir)).toHaveLength(0)
    expect(mod!.castIndexStatus(dir)).toMatchObject({pending:1})
    await mod!.backfillCastIndex(dir)
    expect(mod!.searchCasts('NEWMARKER',10,dir)).toHaveLength(1)
  })

  it('binds opening a hit to its physical part and confirmed version', async () => {
    writeCast(cast('parts.cast'),1_700_000_000,[[0.1,'base output\r\n']])
    writeCast(cast('parts.part000001.cast'),1_700_000_001,[[0.1,'PARTONLY\r\n']])
    await mod!.backfillCastIndex(dir)
    const [hit]=mod!.searchCasts('PARTONLY',10,dir)
    expect((await mod!.readIndexedCastRange(hit.castRel,hit.off,hit.len,hit.version,dir))?.text).toContain('PARTONLY')
    writeCast(cast('parts.part000001.cast'),1_700_000_001,[[0.1,'REPLACED\r\n']])
    expect(await mod!.readIndexedCastRange(hit.castRel,hit.off,hit.len,hit.version,dir)).toBeNull()
  })

  it('keeps CRLF byte ranges readable and reports malformed complete lines as failed', async () => {
    const lines=[JSON.stringify({version:2,width:80,height:24,timestamp:1_700_000_000}),JSON.stringify([0.1,'o','中文 CRLFMARKER\r\n'])]
    fs.writeFileSync(cast('crlf.cast'),lines.join('\r\n')+'\r\n')
    await mod!.indexCast(cast('crlf.cast'),dir)
    const [hit]=mod!.searchCasts('CRLFMARKER',10,dir)
    expect((await mod!.readIndexedCastRange(hit.castRel,hit.off,hit.len,hit.version,dir))?.text).toContain('中文 CRLFMARKER')
    fs.writeFileSync(cast('bad.cast'),lines[0]+'\n{broken complete line}\n')
    await mod!.indexCast(cast('bad.cast'),dir)
    expect(mod!.castIndexStatus(dir).failed).toBe(1)
  })

  it('indexes complete frames only and marks an appended tail as pending', async () => {
    writeCast(cast('live.cast'),1_700_000_000,[[0.1,'SAVEDFRAME\r\n']])
    fs.appendFileSync(cast('live.cast'),'[0.2,"o","PARTIALFRAME"]')
    await mod!.indexCast(cast('live.cast'),dir)
    expect(mod!.searchCasts('PARTIALFRAME',10,dir)).toHaveLength(0)
    expect(mod!.searchCasts('SAVEDFRAME',10,dir)).toHaveLength(1)
    expect(mod!.castIndexStatus(dir).pending).toBe(1)
    fs.appendFileSync(cast('live.cast'),'\n')
    await mod!.backfillCastIndex(dir)
    expect(mod!.searchCasts('PARTIALFRAME',10,dir)).toHaveLength(1)
    expect(mod!.castIndexStatus(dir).pending).toBe(0)
  })

  it('re-indexes without duplicating when the recording grew', async () => {
    writeCast(cast('h.cast'), 1_700_000_000, [[0.1, 'alpha line\r\n']])
    await mod!.indexCast(cast('h.cast'), dir)
    writeCast(cast('h.cast'), 1_700_000_000, [
      [0.1, 'alpha line\r\n'],
      [0.2, 'beta line\r\n']
    ])
    await mod!.indexCast(cast('h.cast'), dir)
    expect(mod!.searchCasts('alpha', 10, dir).length).toBe(1)
    expect(mod!.searchCasts('beta', 10, dir).length).toBe(1)
  })

  it('forgets a pruned recording', async () => {
    // Retention deleting the .cast while its text stays searchable would make
    // the retention policy a lie. This is the test that says so.
    writeCast(cast('i.cast'), 1_700_000_000, [[0.1, 'secret-in-transcript\r\n']])
    await mod!.indexCast(cast('i.cast'), dir)
    expect(mod!.searchCasts('secret-in-transcript', 10, dir).length).toBe(1)
    mod!.pruneCast('i.cast', dir)
    expect(mod!.searchCasts('secret-in-transcript', 10, dir).length).toBe(0)
  })

  it('drops index rows for recordings that vanished behind its back', async () => {
    writeCast(cast('j.cast'), 1_700_000_000, [[0.1, 'ghost-text\r\n']])
    await mod!.indexCast(cast('j.cast'), dir)
    fs.unlinkSync(cast('j.cast'))
    const r = await mod!.backfillCastIndex(dir)
    expect(r.pruned).toBe(1)
    expect(mod!.castIndexStatus(dir)).toMatchObject({total:1,indexed:0,unavailable:1})
    expect((await mod!.backfillCastIndex(dir)).pruned).toBe(0)
    expect(mod!.searchCasts('ghost-text', 10, dir).length).toBe(0)
  })

  it('reports how much is still unindexed', async () => {
    writeCast(cast('k.cast'), 1_700_000_000, [[0.1, 'one\r\n']])
    writeCast(cast('l.cast'), 1_700_000_000, [[0.1, 'two\r\n']])
    expect(mod!.castIndexStatus(dir)).toMatchObject({ total: 2, indexed: 0, pending: 2 })
    await mod!.backfillCastIndex(dir)
    expect(mod!.castIndexStatus(dir)).toMatchObject({ total: 2, indexed: 2, pending: 0 })
  })

  it('survives a truncated or malformed recording', async () => {
    // A cast whose write was cut off mid-line is the normal shape of a crash,
    // which is exactly when the operator most wants to search it.
    fs.writeFileSync(
      cast('m.cast'),
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000 }) + '\n' +
      JSON.stringify([0.1, 'o', 'complete line\r\n']) + '\n' +
      '[0.2,"o","half a li'
    )
    const r = await mod!.indexCast(cast('m.cast'), dir)
    expect(r.skipped).toBeNull()
    expect(mod!.searchCasts('complete', 10, dir).length).toBe(1)
  })

  it('refuses a headerless file rather than indexing garbage', async () => {
    fs.writeFileSync(cast('n.cast'), 'not json at all\n')
    const r = await mod!.indexCast(cast('n.cast'), dir)
    expect(r.skipped).toBe('unreadable')
  })

  it('keeps the index out of the evidence database', async () => {
    // Derived, mutable, rebuildable — none of which describes events.db, and
    // bundle-export copies that file into evidence bundles.
    writeCast(cast('o.cast'), 1_700_000_000, [[0.1, 'x\r\n']])
    await mod!.indexCast(cast('o.cast'), dir)
    expect(fs.existsSync(path.join(dir, 'cast-index.db'))).toBe(true)
  })
})
