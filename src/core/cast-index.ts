import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import Database from 'better-sqlite3'
import { stripAnsi } from './cast-slice'
import { getProjectDir } from './db'

// Full-text search over terminal recordings.
//
// docs/DESIGN-core-and-capture.md §2.4 calls this the highest-leverage single
// capability in that note, because it closes two gaps with one mechanism. Tool
// output was replayable but not queryable — you could watch the nmap run back
// but not ask which run mentioned 445. And an `ssh` into a jump host produces
// no structured commands at all (§2.2), only a stream of bytes; searching
// those bytes is the only thing that makes such a session findable.
//
// What it deliberately does NOT do is parse. "Which runs mention 445" is
// answerable from what was on screen; "list every open port" requires reading
// nmap's XML into structured findings, and what counts as a finding is
// per-shop opinion. That is the same interpretation the positioning lists as
// a non-goal, so the line is drawn at search.
//
// -- Why a separate database file -----------------------------------------
//
// This index is derived, mutable, and rebuildable; the evidence DB is none of
// those. Three things follow that made a table inside events.db wrong:
//
//   1. `events` carries append-only triggers and a hash chain. An index that
//      is rewritten whenever a recording is re-read does not belong beside
//      rows whose immutability is the product's foundation.
//   2. `bundle-export` and `cloud-share` copy the evidence DB. Shipping a
//      search cache inside an evidence bundle means the bundle's bytes change
//      for reasons that have nothing to do with the evidence.
//   3. Retention prunes `.cast` files after N days. If the text survived in
//      an index inside the evidence DB, retention would be silently
//      incomplete — the recording is gone and its contents are still
//      searchable. `pruneCast` below exists for exactly this, and
//      retention.ts calls it.
//
// -- Why token search rather than substring --------------------------------
//
// A trigram tokenizer would give grep semantics, which is what an operator
// reaching for this expects. It also costs roughly 3x the indexed text on
// disk, and a 50 MB cap per recording across an engagement's worth of
// sessions makes that the difference between an index that ships and one that
// fills the disk.
//
// unicode61 with prefix indexes covers what operators actually type -- an IP,
// a port, a hostname, a tool name, a word from an error -- because those are
// token-initial. `searchCasts` appends `*` to the final term so a half-typed
// word still matches. It will not find `soft-ds` inside `microsoft-ds`, and
// the UI says so rather than letting the operator conclude the bytes are
// missing.

const MAX_CAST_BYTES = 60 * 1024 * 1024

/** Target size of an indexed chunk, in stripped characters.
 *
 *  This is the granularity of a search hit, so it is a readability choice
 *  before it is a performance one: small enough that a hit points at
 *  something an operator can read in place, large enough that a phrase
 *  spanning two writes still lands in one chunk. */
const CHUNK_CHARS = 1800

let idx: Database.Database | null = null
let idxDir: string | null = null

function indexPath(projectDir: string): string {
  return path.join(projectDir, 'cast-index.db')
}

export function getCastIndex(projectDir?: string): Database.Database {
  const dir = projectDir ?? getProjectDir()
  if (idx && idxDir === dir) return idx
  if (idx) { try { idx.close() } catch { /* already closed */ } }
  const db = new Database(indexPath(dir))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cast_fts USING fts5(
      text,
      cast_rel UNINDEXED,
      t_ms     UNINDEXED,
      off      UNINDEXED,
      len      UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix   = '2 3'
    );
    CREATE TABLE IF NOT EXISTS cast_files (
      cast_rel   TEXT PRIMARY KEY,
      sha256     TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      chunks     INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
  `)
  idx = db
  idxDir = dir
  return db
}

export function closeCastIndex(): void {
  if (idx) { try { idx.close() } catch { /* already closed */ } }
  idx = null
  idxDir = null
}

export interface IndexResult {
  castRel: string
  chunks: number
  skipped: 'unchanged' | 'too-large' | 'unreadable' | null
}

/**
 * Index one recording. Idempotent: a cast whose sha256 already matches the
 * stored one is skipped, so re-running the backfill is cheap and a partially
 * indexed project converges rather than duplicating.
 *
 * Offsets are byte positions in the `.cast` file, line-aligned, so a hit can
 * be read back through `readCastRange` — the same path the timeline already
 * uses for per-command replay.
 */
export async function indexCast(castPath: string, projectDir?: string): Promise<IndexResult> {
  const dir = projectDir ?? getProjectDir()
  const castRel = path.relative(path.join(dir, 'casts'), castPath).split(path.sep).join('/')
  const db = getCastIndex(dir)

  let stat: fs.Stats
  try { stat = fs.statSync(castPath) } catch { return { castRel, chunks: 0, skipped: 'unreadable' } }
  if (stat.size > MAX_CAST_BYTES) return { castRel, chunks: 0, skipped: 'too-large' }

  let sha: string
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(castPath)).digest('hex') }
  catch { return { castRel, chunks: 0, skipped: 'unreadable' } }

  const prior = db.prepare('SELECT sha256, chunks FROM cast_files WHERE cast_rel = ?').get(castRel) as
    { sha256: string; chunks: number } | undefined
  if (prior?.sha256 === sha) return { castRel, chunks: prior.chunks, skipped: 'unchanged' }

  // A cast that grew since its last index is re-read from the start rather
  // than appended to. Sessions are capped at 50 MB and indexed once at close,
  // so the repeat case is rare; getting the incremental bookkeeping wrong
  // would produce a silently partial index, which is the failure this whole
  // feature exists to prevent.
  db.prepare('DELETE FROM cast_fts WHERE cast_rel = ?').run(castRel)

  const stream = fs.createReadStream(castPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const insert = db.prepare('INSERT INTO cast_fts (text, cast_rel, t_ms, off, len) VALUES (?, ?, ?, ?, ?)')
  const pending: Array<[string, string, number, number, number]> = []

  let header: { timestamp?: number } | null = null
  let castStartMs = 0
  let bytePos = 0
  let buf = ''
  let chunkOff = 0
  let chunkTs = 0
  let chunks = 0
  let streamError: Error | null = null
  stream.on('error', (err) => { streamError = err })

  const flush = (endOff: number): void => {
    const text = buf.trim()
    buf = ''
    if (!text) return
    pending.push([text, castRel, chunkTs, chunkOff, endOff - chunkOff])
    chunks++
  }

  try {
    for await (const line of rl) {
      if (streamError) break
      const lineStart = bytePos
      bytePos += Buffer.byteLength(line, 'utf8') + 1
      if (!line) continue
      if (!header) {
        try { header = JSON.parse(line) } catch { rl.close(); stream.destroy(); return { castRel, chunks: 0, skipped: 'unreadable' } }
        if (!header || typeof header.timestamp !== 'number') {
          rl.close(); stream.destroy(); return { castRel, chunks: 0, skipped: 'unreadable' }
        }
        castStartMs = header.timestamp * 1000
        continue
      }
      let ev: unknown
      try { ev = JSON.parse(line) } catch { continue }
      if (!Array.isArray(ev) || ev.length < 3) continue
      if (ev[1] !== 'o' || typeof ev[0] !== 'number' || typeof ev[2] !== 'string') continue
      if (!buf) { chunkOff = lineStart; chunkTs = Math.round(castStartMs + (ev[0] as number) * 1000) }
      buf += stripAnsi(ev[2] as string)
      if (buf.length >= CHUNK_CHARS) flush(bytePos)
    }
  } catch { /* readline aborted — index what was read */ }

  flush(bytePos)
  if (!header) return { castRel, chunks: 0, skipped: 'unreadable' }

  const write = db.transaction(() => {
    for (const row of pending) insert.run(...row)
    db.prepare(
      `INSERT INTO cast_files (cast_rel, sha256, bytes, chunks, indexed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cast_rel) DO UPDATE SET sha256=excluded.sha256, bytes=excluded.bytes,
         chunks=excluded.chunks, indexed_at=excluded.indexed_at`
    ).run(castRel, sha, stat.size, chunks, Date.now())
  })
  write()

  return { castRel, chunks, skipped: null }
}

export interface CastHit {
  castRel: string
  /** Wall-clock ms of the first output event in the matching chunk. */
  tMs: number
  /** Byte range in the `.cast`, for readCastRange. */
  off: number
  len: number
  /** The matching text, elided around the match. */
  snippet: string
}

/** FTS5 MATCH treats bare punctuation and operators as syntax. Terminal
 *  searches are full of both — `10.0.0.5`, `-sV`, `/etc/passwd` — so each
 *  term is quoted as a phrase rather than handed through, and only a
 *  trailing `*` is added, deliberately. */
function toMatchQuery(raw: string): string | null {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms
    .map((term, i) => {
      const quoted = `"${term.replace(/"/g, '""')}"`
      // Prefix-match only the last term: the operator is still typing it.
      return i === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

export function searchCasts(query: string, limit = 50, projectDir?: string): CastHit[] {
  const match = toMatchQuery(query)
  if (!match) return []
  const db = getCastIndex(projectDir)
  try {
    return db.prepare(
      `SELECT cast_rel AS castRel, t_ms AS tMs, off, len,
              snippet(cast_fts, 0, '', '', '...', 24) AS snippet
       FROM cast_fts WHERE cast_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(match, limit) as CastHit[]
  } catch {
    // A malformed MATCH is a bad query, not a broken index. Empty beats a
    // dialog explaining FTS5 syntax to someone who typed a path.
    return []
  }
}

/** Drop a recording's text. Called by retention when the `.cast` is swept —
 *  an index that outlives the file it describes turns a retention policy into
 *  a lie. */
export function pruneCast(castRel: string, projectDir?: string): void {
  const db = getCastIndex(projectDir)
  db.transaction(() => {
    db.prepare('DELETE FROM cast_fts WHERE cast_rel = ?').run(castRel)
    db.prepare('DELETE FROM cast_files WHERE cast_rel = ?').run(castRel)
  })()
}

export interface BackfillStatus {
  total: number
  indexed: number
  pending: number
}

export function castIndexStatus(projectDir?: string): BackfillStatus {
  const dir = projectDir ?? getProjectDir()
  const castsDir = path.join(dir, 'casts')
  let names: string[] = []
  try { names = fs.readdirSync(castsDir).filter((n) => n.endsWith('.cast')) } catch { /* no casts yet */ }
  const db = getCastIndex(dir)
  const known = new Set(
    (db.prepare('SELECT cast_rel FROM cast_files').all() as Array<{ cast_rel: string }>).map((r) => r.cast_rel)
  )
  const indexed = names.filter((n) => known.has(n)).length
  return { total: names.length, indexed, pending: names.length - indexed }
}

/**
 * Index every recording not already covered, and drop rows for recordings
 * that no longer exist.
 *
 * The second half matters as much as the first: retention calls `pruneCast`
 * on the files it sweeps, but a cast deleted by hand, by a restore, or by a
 * sweep from an older build leaves text behind. A backfill that only ever
 * adds would let those accumulate silently.
 */
export async function backfillCastIndex(
  projectDir?: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ indexed: number; pruned: number }> {
  const dir = projectDir ?? getProjectDir()
  const castsDir = path.join(dir, 'casts')
  let names: string[] = []
  try { names = fs.readdirSync(castsDir).filter((n) => n.endsWith('.cast')) } catch { return { indexed: 0, pruned: 0 } }

  const db = getCastIndex(dir)
  const known = (db.prepare('SELECT cast_rel FROM cast_files').all() as Array<{ cast_rel: string }>)
    .map((r) => r.cast_rel)
  const present = new Set(names)
  let pruned = 0
  for (const rel of known) {
    if (!present.has(rel)) { pruneCast(rel, dir); pruned++ }
  }

  let indexed = 0
  for (let i = 0; i < names.length; i++) {
    const r = await indexCast(path.join(castsDir, names[i]), dir)
    if (r.skipped === null) indexed++
    onProgress?.(i + 1, names.length)
  }
  return { indexed, pruned }
}
