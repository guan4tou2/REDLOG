import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { stripAnsi, readSingleCastRange, type CastSlice } from './cast-slice'
import { getProjectDir } from './db'
import { ftsTerms } from './query/fts-match'

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
//   2. `bundle-export` copies the evidence DB. Shipping a
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
const generations = new Map<string,{sha:string;bytes:number;size:number;signature:string}>()

function generation(file: string, dir: string, prefix?: number): {sha:string;bytes:number;size:number;signature:string} {
  const folder=path.resolve(dir,'casts')
  if(path.dirname(path.resolve(file))!==folder)throw new Error('unreadable')
  const directory=fs.lstatSync(folder,{bigint:true}), named=fs.lstatSync(file,{bigint:true})
  if(!directory.isDirectory()||directory.isSymbolicLink()||!named.isFile()||named.isSymbolicLink())throw new Error('unreadable')
  if(named.size>BigInt(MAX_CAST_BYTES))throw new Error('too-large')
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0))
  try {
    const signature=(s:fs.BigIntStats):string=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')
    if(signature(fs.fstatSync(fd,{bigint:true}))!==signature(named))throw new Error('unreadable')
    const key=`${file}:${prefix??'complete'}`,cached=generations.get(key)
    if(cached?.signature===signature(named))return cached
    const size=Number(named.size),buf=Buffer.alloc(65536)
    let bytes=prefix??0
    if(prefix===undefined){
      for(let end=size;end>0;){const start=Math.max(0,end-buf.length),n=fs.readSync(fd,buf,0,end-start,start),last=buf.subarray(0,n).lastIndexOf(10)
        if(last>=0){bytes=start+last+1;break}end=start}
    }
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>size)throw new Error('unreadable')
    const hash=crypto.createHash('sha256')
    for(let off=0;off<bytes;off+=buf.length){const length=Math.min(buf.length,bytes-off),n=fs.readSync(fd,buf,0,length,off)
      if(n!==length)throw new Error('unreadable');hash.update(buf.subarray(0,n))}
    if(signature(fs.fstatSync(fd,{bigint:true}))!==signature(named)||signature(fs.lstatSync(file,{bigint:true}))!==signature(named)
      ||fs.lstatSync(folder,{bigint:true}).ino!==directory.ino)throw new Error('unreadable')
    const result={sha:hash.digest('hex'),bytes,size,signature:signature(named)}
    if(generations.size>=1024)generations.delete(generations.keys().next().value!)
    generations.set(key,result)
    return result
  } finally {fs.closeSync(fd)}
}

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
  if(db.pragma('user_version',{simple:true})!==2)db.exec('DROP TABLE IF EXISTS cast_fts; DROP TABLE IF EXISTS cast_files;')
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
      indexed_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'indexed'
    );
    PRAGMA user_version=2;
  `)
  idx = db
  idxDir = dir
  return db
}

export function closeCastIndex(): void {
  if (idx) { try { idx.close() } catch { /* already closed */ } }
  idx = null
  idxDir = null
  generations.clear()
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
  const fail = (reason: 'too-large' | 'unreadable', status=reason === 'too-large' ? 'unsupported' : 'failed'): IndexResult => {
    db.transaction(() => {
      db.prepare('DELETE FROM cast_fts WHERE cast_rel=?').run(castRel)
      db.prepare(`INSERT INTO cast_files VALUES(?,'',0,0,?,?) ON CONFLICT(cast_rel) DO UPDATE SET sha256='',bytes=0,status=excluded.status,chunks=0`)
        .run(castRel, Date.now(), status)
    })()
    return { castRel, chunks: 0, skipped: reason }
  }
  let state: ReturnType<typeof generation>
  try { state = generation(castPath, dir) }
  catch (error) { return fail((error as Error).message === 'too-large' ? 'too-large' : 'unreadable') }
  if (!state.bytes) return state.size>1024*1024?fail('too-large'):fail('unreadable','pending')
  const prior = db.prepare('SELECT sha256,bytes,chunks,status FROM cast_files WHERE cast_rel=?').get(castRel) as
    { sha256: string; bytes: number; chunks: number; status: string } | undefined
  if (prior?.sha256 === state.sha && prior.bytes === state.bytes && ['indexed', 'partial'].includes(prior.status))
    return { castRel, chunks: prior.chunks, skipped: 'unchanged' }

  let fd: number | undefined
  try {
    fd = fs.openSync(castPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(fd, {bigint:true})
    if ([opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].join(':') !== state.signature) throw new Error('changed')
    const rows: Array<[string, string, number, number, number]> = []
    let header = false, startMs = 0, off = 0, lineOff = 0, chunkOff = 0, chunkTs = 0, text = ''
    let carry = Buffer.alloc(0)
    const flush = (end: number): void => {
      if (text.trim()) rows.push([text.trim(), castRel, chunkTs, chunkOff, end - chunkOff])
      text = ''
    }
    const decoder = new TextDecoder('utf-8', {fatal:true})
    while (off < state.bytes) {
      const bytes = Buffer.alloc(Math.min(65536, state.bytes - off))
      if (fs.readSync(fd, bytes, 0, bytes.length, off) !== bytes.length) throw new Error('changed')
      off += bytes.length
      carry = Buffer.concat([carry, bytes])
      let at: number
      while ((at = carry.indexOf(10)) >= 0) {
        const length = at + 1, end = lineOff + length
        const line = decoder.decode(carry.subarray(0, at)).trim()
        carry = carry.subarray(length)
        if (line) {
          const value: unknown = JSON.parse(line)
          if (!header) {
            const h = value as {version?:number;timestamp?:number}
            if (h?.version !== 2 || !Number.isFinite(h.timestamp)) throw new Error('invalid header')
            startMs = h.timestamp! * 1000; header = true
          } else if (Array.isArray(value) && value[1] === 'o' && Number.isFinite(value[0]) && typeof value[2] === 'string') {
            if (!text) {chunkOff = lineOff; chunkTs = Math.round(startMs + value[0] * 1000)}
            text += stripAnsi(value[2])
            // A write boundary is not necessarily a token boundary.
            if (text.length >= CHUNK_CHARS && /[^\p{L}\p{N}\p{Co}\p{M}]$/u.test(text)) flush(end)
          }
        }
        lineOff = end
      }
      // A pathological single frame remains saved, but is explicitly unsupported.
      if (carry.length > 1024 * 1024) return fail('too-large')
    }
    flush(state.bytes)
    if (!header || generation(castPath, dir, state.bytes).sha !== state.sha) throw new Error('changed')
    db.transaction(() => {
      db.prepare('DELETE FROM cast_fts WHERE cast_rel=?').run(castRel)
      const insert = db.prepare('INSERT INTO cast_fts(text,cast_rel,t_ms,off,len) VALUES(?,?,?,?,?)')
      for (const row of rows) insert.run(...row)
      db.prepare(`INSERT INTO cast_files VALUES(?,?,?,?,?,'indexed') ON CONFLICT(cast_rel) DO UPDATE SET
        sha256=excluded.sha256,bytes=excluded.bytes,chunks=excluded.chunks,indexed_at=excluded.indexed_at,status='indexed'`)
        .run(castRel, state.sha, state.bytes, rows.length, Date.now())
    })()
    return {castRel, chunks:rows.length, skipped:null}
  } catch {return fail('unreadable')}
  finally {if (fd !== undefined) fs.closeSync(fd)}
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
  version: string
}

function validateIndex(dir:string):void {
  const db=getCastIndex(dir)
  const rows=db.prepare('SELECT cast_rel,sha256,bytes,status FROM cast_files').all() as {cast_rel:string;sha256:string;bytes:number;status:string}[]
  db.transaction(()=>{for(const row of rows){
    let status=row.status
    try{
      const file=path.join(dir,'casts',row.cast_rel),current=generation(file,dir,row.bytes)
      if(!row.sha256)status=row.status
      else if(current.sha!==row.sha256 || !['indexed','partial'].includes(row.status))status='pending'
      else status=current.size>row.bytes?'partial':'indexed'
    }catch(error){status=(error as NodeJS.ErrnoException).code==='ENOENT'?'unavailable':(error as Error).message==='too-large'?'unsupported':'failed'}
    if(status!=='indexed'&&status!=='partial')db.prepare('DELETE FROM cast_fts WHERE cast_rel=?').run(row.cast_rel)
    db.prepare('UPDATE cast_files SET status=? WHERE cast_rel=?').run(status,row.cast_rel)
  }})()
}

export function searchCasts(query: string, limit = 50, projectDir?: string): CastHit[] {
  const terms=ftsTerms(query)
  if(!terms.length)return []
  const dir=projectDir??getProjectDir()
  validateIndex(dir)
  // No catch. toFtsMatch quotes every term, so no typed input is malformed
  // MATCH syntax; an error here is the index failing, and Search shows it as
  // a failure rather than as recordings that never held the term.
  return getCastIndex(projectDir).prepare(
    `WITH matched_files AS (${terms.map(()=> 'SELECT cast_rel FROM cast_fts WHERE cast_fts MATCH ?').join(' INTERSECT ')})
     SELECT cast_rel AS castRel, t_ms AS tMs, off, len,
            snippet(cast_fts, 0, '', '', '...', 24) AS snippet,
            (SELECT 'cast1:'||bytes||':'||sha256 FROM cast_files f WHERE f.cast_rel=cast_fts.cast_rel) AS version
     FROM cast_fts WHERE cast_fts MATCH ? AND cast_rel IN (SELECT cast_rel FROM matched_files) ORDER BY rank LIMIT ?`
  ).all(...terms,terms.join(' OR '),Math.max(1,Math.min(limit,1000))) as CastHit[]
}

/** Search offsets belong to one physical file, never the combined Session. */
export async function readIndexedCastRange(castRel:string,off:number,len:number,version:string,projectDir=getProjectDir()):Promise<CastSlice|null> {
  const parsed=/^cast1:(\d+):([a-f0-9]{64})$/.exec(version)
  if(!parsed||!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<=0)return null
  const bytes=Number(parsed[1]),file=path.resolve(projectDir,'casts',castRel)
  if(!Number.isSafeInteger(bytes)||off+len>bytes)return null
  try {
    if(generation(file,projectDir,bytes).sha!==parsed[2])return null
    const read=await readSingleCastRange(file,off,len)
    return generation(file,projectDir,bytes).sha===parsed[2]?read:null
  } catch {return null}
}

/** Drop a recording's text. Called by retention when the `.cast` is swept —
 *  an index that outlives the file it describes turns a retention policy into
 *  a lie. */
export function pruneCast(castRel: string, projectDir?: string): void {
  const db = getCastIndex(projectDir)
  db.transaction(() => {
    db.prepare('DELETE FROM cast_fts WHERE cast_rel = ?').run(castRel)
    // Keep only a tombstone so a missing source cannot look fully covered.
    db.prepare("UPDATE cast_files SET status='unavailable',chunks=0 WHERE cast_rel = ?").run(castRel)
  })()
}

export interface BackfillStatus {
  total: number
  indexed: number
  pending: number
  partial:number
  failed:number
  unsupported:number
  unavailable:number
  revision:string
  indexedBytes:number
  sourceBytes:number
}

export function castIndexStatus(projectDir?: string): BackfillStatus {
  const dir = projectDir ?? getProjectDir()
  const castsDir = path.join(dir, 'casts')
  let names: string[] = []
  try { names = fs.readdirSync(castsDir).filter((n) => n.endsWith('.cast')) }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  validateIndex(dir)
  const rows=getCastIndex(dir).prepare('SELECT cast_rel,sha256,bytes,status FROM cast_files ORDER BY cast_rel').all() as {cast_rel:string;sha256:string;bytes:number;status:string}[]
  const status:BackfillStatus={total:new Set([...names,...rows.map(row=>row.cast_rel)]).size,indexed:0,pending:0,partial:0,failed:0,unsupported:0,unavailable:0,revision:'',indexedBytes:0,sourceBytes:0}
  const known=new Set(rows.map(r=>r.cast_rel)),hash=crypto.createHash('sha256')
  for(const name of names)if(!known.has(name)){status.pending++;hash.update(name)}
  for(const row of rows){
    if(row.status==='indexed')status.indexed++
    else if(row.status==='partial'){status.partial++;status.pending++}
    else if(row.status==='failed'||row.status==='unsupported'||row.status==='unavailable')status[row.status]++
    else status.pending++
    status.indexedBytes+=row.status==='indexed'||row.status==='partial'?row.bytes:0
    try{status.sourceBytes+=fs.lstatSync(path.join(castsDir,row.cast_rel)).size}catch{}
    hash.update(JSON.stringify([row.cast_rel,row.sha256,row.bytes,row.status]))
  }
  status.revision=hash.digest('hex')
  return status
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
  try { names = fs.readdirSync(castsDir).filter((n) => n.endsWith('.cast')) }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}

  const db = getCastIndex(dir)
  const known = db.prepare('SELECT cast_rel,status FROM cast_files').all() as Array<{ cast_rel: string;status:string }>
  const present = new Set(names)
  let pruned = 0
  for (const row of known) {
    if (!present.has(row.cast_rel)&&row.status!=='unavailable') { pruneCast(row.cast_rel, dir); pruned++ }
  }

  let indexed = 0
  for (let i = 0; i < names.length; i++) {
    const r = await indexCast(path.join(castsDir, names[i]), dir)
    if (r.skipped === null) indexed++
    onProgress?.(i + 1, names.length)
  }
  return { indexed, pruned }
}
