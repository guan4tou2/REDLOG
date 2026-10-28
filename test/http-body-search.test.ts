import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseQuery } from '../src/core/query/contract'
import type { EventFilter } from '../src/core/db/event-queries'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'node:crypto'
import { addArtifact } from '../src/core/artifacts'
import { describeEventContent, readEventContent } from '../src/core/evidence-content'
import { sweepRetention } from '../src/core/retention'
import Database from 'better-sqlite3'
import { readActivitySnapshot } from '../src/core/db/dataset-snapshot'
import { getReadonlyDB } from '../src/core/db/index'

let initDB: typeof import('../src/core/db').initDB
let closeDB: typeof import('../src/core/db').closeDB
let ingest: typeof import('../src/core/ingest').ingest
let executeEventQuery: typeof import('../src/core/db/event-queries').executeEventQuery
let closeHttpBodyIndex: typeof import('../src/core/http-body-index').closeHttpBodyIndex
let pruneHttpBodyIndex: typeof import('../src/core/http-body-index').pruneHttpBodyIndex
let storeBody: typeof import('../src/core/http-body-store').storeBody
let insertEvent: typeof import('../src/core/db/events').insertEvent
let available = false

try {
  const db = await import('../src/core/db')
  const events = await import('../src/core/db/events')
  const ing = await import('../src/core/ingest')
  const idx = await import('../src/core/http-body-index')
  const bodies = await import('../src/core/http-body-store')
  initDB = db.initDB
  closeDB = db.closeDB
  ingest = ing.ingest
  executeEventQuery = events.executeEventQuery
  closeHttpBodyIndex = idx.closeHttpBodyIndex
  pruneHttpBodyIndex = idx.pruneHttpBodyIndex
  storeBody = bodies.storeBody
  insertEvent = events.insertEvent
  available = true
} catch { /* native SQLite unavailable */ }


// Spec 026: Search's paged text query is the query contract. The pagination,
// filter and body-search assertions below were written against the retired
// `searchEventsPage`; they run unchanged against the contract through this.
function searchPage(opts: EventFilter & { query: string; limit?: number; cursor?: string | null }) {
  const outcome = parseQuery(opts.query)
  if (!outcome.ok) throw new Error(`test query did not parse: ${outcome.reason}`)
  const { query: _query, limit, cursor, ...filter } = opts
  return executeEventQuery({ parsed: outcome.parsed, filter, limit, cursor })
}

const describeDB = available ? describe : describe.skip
let dir: string

describeDB('HTTP body search', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-search-'))
    initDB(dir)
  })
  afterEach(() => {
    closeHttpBodyIndex()
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function response(id: string, marker: string, targetId = 'api.test'): string {
    const result = ingest({
      agentType: 'scanner', engagementId: 'eng', operatorId: 'op', targetId,
      data: {
        subtype: 'http_response', flow_id: id, url: `https://${targetId}/${id}`, status: 200,
        response_body: { data: `${'x'.repeat(5000)} ${marker}`, encoding: 'text', size: 5010, sha256: 'producer-value' }
      }
    })
    return result.event!.id
  }

  it('indexes large saved output through its tail, multi-chunk terms and UTF-8 boundaries', () => {
    const text = 'HEADONLY ' + 'normal output 漢字\n'.repeat(950000) + ' TAILONLY';
    expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1024 * 1024)
    const ref = storeBody({data:text,encoding:'text',size:Buffer.byteLength(text),sha256:''})!
    const event = insertEvent('shell',{subtype:'command_end',stdout_ref:ref}, {engagementId:'eng',operatorId:'op'})!
    expect(searchPage({query:'TAILONLY',limit:10}).items.map(e=>e.id)).toEqual([event.id])
    const head=storeBody({data:'HEADONLY',encoding:'text',size:8,sha256:''})!
    const tail=storeBody({data:'TAILONLY',encoding:'text',size:8,sha256:''})!
    insertEvent('shell',{stdout_ref:head,stderr_ref:tail},{engagementId:'eng',operatorId:'op'})
    expect(searchPage({query:'HEADONLY TAILONLY',limit:10}).items.map(e=>e.id)).toEqual([event.id])
    expect(searchPage({query:'漢字',limit:10}).items.map(e=>e.id)).toEqual([event.id])
    fs.writeFileSync(path.join(dir,'http-bodies',ref.file), 'changed')
    expect(searchPage({query:'TAILONLY',limit:10}).items.map(e=>e.id)).not.toContain(event.id)
  }, 30000)

  it('keeps punctuation phrases at chunk boundaries without indexing token suffixes', () => {
    const prefix='x'.repeat(1024*1024-65536)
    const text=prefix+'suffixcanary'+'x'.repeat(200000)+' /admin/login?boundary=needle';
    const ref=storeBody({data:text,encoding:'text',size:text.length,sha256:''})!
    const event=insertEvent('shell',{stdout_ref:ref},{engagementId:'eng',operatorId:'op'})!
    expect(searchPage({query:'suffixcanary',limit:10}).items).toHaveLength(0)
    expect(searchPage({query:'/admin/login?boundary=needle',limit:10}).items.map(e=>e.id)).toEqual([event.id])
  })

  it('finds a marker that exists only in an externalized response body', () => {
    const id = response('f1', 'BODYMARKER-9182')
    const page = searchPage({ query: 'BODYMARKER-9182', limit: 10 })
    expect(page.items.map((event) => event.id)).toEqual([id])
  })

  it('searches decoded small inline base64 bodies using the same bytes as the Reader', () => {
    const data=Buffer.from('SMALLBASE64ONLY 中文').toString('base64')
    const event=insertEvent('scanner',{subtype:'http_response',response_body:{data,encoding:'base64'}},{engagementId:'eng',operatorId:'op'})!
    expect(searchPage({query:'SMALLBASE64ONLY'}).items.map(e=>e.id)).toEqual([event.id])
    const described=describeEventContent('eng',event.id)
    if(!described.ok)throw new Error(described.message)
    expect(readEventContent({ref:described.value.find(f=>f.field==='response_body')!.ref!})).toMatchObject({ok:true,value:{text:'SMALLBASE64ONLY 中文'}})
  })

  it('finds saved text attachments and opens their verified source, never their original path', () => {
    const original = path.join(dir, 'report.txt')
    fs.writeFileSync(original, 'saved attachment tail ATTACHMENTONLY')
    const added = addArtifact(dir, original)
    if (!added.ok) throw new Error('fixture copy failed')
    const event = insertEvent('file_transfer', { subtype: 'artifact_added', stored: added.stored,
      sha256: added.sha256, size: added.bytes, path: original }, { engagementId: 'eng', operatorId: 'op' })!
    fs.writeFileSync(original, 'UNSAVEDORIGINAL')
    expect(searchPage({query:'ATTACHMENTONLY'}).items.map(e=>e.id)).toEqual([event.id])
    expect(searchPage({query:'UNSAVEDORIGINAL'}).items).toHaveLength(0)
    const described = describeEventContent('eng', event.id)
    expect(described.ok).toBe(true)
    if (!described.ok) return
    const field = described.value.find(f => f.field === 'artifact' as string)
    expect(field?.ref).toBeTruthy()
    expect(readEventContent({ref:field!.ref!})).toMatchObject({ok:true,value:{text:'saved attachment tail ATTACHMENTONLY'}})
    fs.writeFileSync(path.join(dir,added.stored), 'tampered attachment')
    const page = searchPage({query:'ATTACHMENTONLY'})
    expect(page.items).toHaveLength(0)
    expect(page.bodyCoverage?.failed).toBe(1)
  })

  it('searches only a confirmed AI raw prefix and rejects changed bytes or unsupported time filters', () => {
    const folder = path.join(dir, 'agent-transcripts'); fs.mkdirSync(folder)
    const file = path.join(folder, 'claude-session.jsonl')
    const saved = '{"hidden_field":"RAWPREFIXONLY"}\n'
    fs.writeFileSync(file, saved)
    const event = insertEvent('agent', { subtype:'transcript_snapshot',agent:'claude-code',session_id:'conversation',
      snapshot_path:file,cumulative_bytes:Buffer.byteLength(saved),cumulative_sha256:createHash('sha256').update(saved).digest('hex') }, {engagementId:'eng',operatorId:'op'})!
    fs.appendFileSync(file, '{"unconfirmed":"UNCONFIRMEDTAIL"}\n')
    expect(searchPage({query:'RAWPREFIXONLY'}).items.map(e=>e.id)).toEqual([event.id])
    expect(searchPage({query:'UNCONFIRMEDTAIL'}).items).toHaveLength(0)
    const restricted = searchPage({query:'RAWPREFIXONLY',since:1})
    expect(restricted.items).toHaveLength(0)
    expect(restricted.bodyCoverage?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'ai-raw',status:'unsupported',unsupported:1,indexedBytes:0})
    ]))
    const described = describeEventContent('eng',event.id)
    if (!described.ok) throw new Error(described.message)
    const raw = described.value.find(f=>f.field==='ai_raw' as string)
    expect(raw?.ref).toBeTruthy()
    expect(readEventContent({ref:raw!.ref!})).toMatchObject({ok:true,value:{text:saved,total:Buffer.byteLength(saved)}})
    fs.writeFileSync(file,saved.replace('RAWPREFIXONLY','OTHERCONTENTX'))
    const page = searchPage({query:'RAWPREFIXONLY'})
    expect(page.items).toHaveLength(0)
    expect(page.bodyCoverage?.failed).toBe(1)
  })

  it('binds raw-event paging to the query dataset and saved-content revision', () => {
    insertEvent('marker',{title:'pagecanary'},{engagementId:'eng',operatorId:'op'})
    insertEvent('marker',{title:'pagecanary'},{engagementId:'eng',operatorId:'op'})
    const original=path.join(dir,'page.txt');fs.writeFileSync(original,'other saved content')
    const added=addArtifact(dir,original)
    if(!added.ok)throw new Error('fixture copy failed')
    insertEvent('file_transfer',{subtype:'artifact_added',stored:added.stored,sha256:added.sha256,size:added.bytes},{engagementId:'eng',operatorId:'op'})
    const first=searchPage({query:'pagecanary',limit:1})
    expect(first.nextCursor).toBeTruthy()
    insertEvent('marker',{title:'pagecanary'},{engagementId:'eng',operatorId:'op'})
    expect(searchPage({query:'pagecanary',limit:1,cursor:first.nextCursor}).items).toHaveLength(1)
    fs.unlinkSync(path.join(dir,added.stored))
    expect(()=>searchPage({query:'pagecanary',limit:1,cursor:first.nextCursor})).toThrow(/coverage|source|changed/i)
  })

  it('reports unconfirmed AI bytes as pending without searching them, then admits the confirmed prefix', () => {
    fs.mkdirSync(path.join(dir,'agent-transcripts'))
    const file=path.join(dir,'agent-transcripts','pending.jsonl'),text='{"value":"CONFIRMEDLATER"}\n'
    fs.writeFileSync(file,text)
    insertEvent('agent',{subtype:'transcript_capture_started',agent:'codex',session_id:'pending',sidecar_file:'pending.jsonl'}, {engagementId:'eng',operatorId:'op'})
    const pending=searchPage({query:'CONFIRMEDLATER'})
    expect(pending.items).toHaveLength(0)
    expect(pending.bodyCoverage?.sources).toEqual(expect.arrayContaining([expect.objectContaining({kind:'ai-raw',status:'pending',pending:1})]))
    const event=insertEvent('agent',{subtype:'transcript_snapshot',agent:'codex',session_id:'pending',snapshot_path:file,
      cumulative_bytes:Buffer.byteLength(text),cumulative_sha256:createHash('sha256').update(text).digest('hex')},{engagementId:'eng',operatorId:'op'})!
    const ready=searchPage({query:'CONFIRMEDLATER'})
    expect(ready.items.map(e=>e.id)).toEqual([event.id])
    expect(ready.bodyCoverage?.sources).toEqual(expect.arrayContaining([expect.objectContaining({kind:'ai-raw',status:'covered',pending:0,indexed:1})]))
  })

  it('distinguishes binary contents from filename search and refuses references outside saved folders', () => {
    const original=path.join(dir,'sample.png');fs.writeFileSync(original,Buffer.concat([Buffer.from([0,255]),Buffer.from('BINARYONLY')]))
    const added=addArtifact(dir,original)
    if(!added.ok)throw new Error('fixture copy failed')
    const binary=insertEvent('file_transfer',{subtype:'artifact_added',stored:added.stored,sha256:added.sha256,size:added.bytes},{engagementId:'eng',operatorId:'op'})!
    expect(searchPage({query:'sample.png'}).items.map(e=>e.id)).toEqual([binary.id])
    const page=searchPage({query:'BINARYONLY'})
    expect(page.items).toHaveLength(0)
    expect(page.bodyCoverage?.sources).toEqual(expect.arrayContaining([expect.objectContaining({kind:'artifact',status:'unsupported',binary:1,indexedBytes:0})]))
    const outside=path.join(dir,'outside.jsonl'),text='EXTERNALONLY';fs.writeFileSync(outside,text)
    insertEvent('agent',{subtype:'transcript_snapshot',snapshot_path:outside,cumulative_bytes:text.length,
      cumulative_sha256:createHash('sha256').update(text).digest('hex')},{engagementId:'eng',operatorId:'op'})
    expect(searchPage({query:'EXTERNALONLY'}).items).toHaveLength(0)
    expect(searchPage({query:'EXTERNALONLY'}).bodyCoverage?.failed).toBe(1)
  })

  it('removes AI raw full text from the derived database at retention time', () => {
    fs.mkdirSync(path.join(dir,'agent-transcripts'))
    const file=path.join(dir,'agent-transcripts','prune.jsonl'),text='{"saved":"PRIVACYRETENTION"}\n'
    fs.writeFileSync(file,text)
    insertEvent('agent',{subtype:'transcript_snapshot',snapshot_path:file,cumulative_bytes:Buffer.byteLength(text),
      cumulative_sha256:createHash('sha256').update(text).digest('hex')},{engagementId:'eng',operatorId:'op'})
    expect(searchPage({query:'PRIVACYRETENTION'}).items).toHaveLength(1)
    const old=new Date(Date.now()-10*86400000);fs.utimesSync(file,old,old)
    expect(sweepRetention({retention:{agentTranscripts:{keepDays:1}}},{engagementId:'eng',operatorId:'op'}).agentTranscripts).toBe(1)
    const cache=new Database(path.join(dir,'http-body-index.db'),{readonly:true})
    try { expect(cache.prepare("SELECT count(*) AS n FROM body_fts WHERE body_fts MATCH 'PRIVACYRETENTION'").get()).toEqual({n:0}) }
    finally {cache.close()}
  })

  it('indexes the latest confirmed file prefix once and respects an older query dataset', () => {
    fs.mkdirSync(path.join(dir,'agent-transcripts'))
    const file=path.join(dir,'agent-transcripts','versions.jsonl')
    let text='',firstId='',lastId='',old:ReturnType<typeof readActivitySnapshot>|undefined
    for(let i=0;i<20;i++){
      text+=`{"message":"VERSIONCANARY ${i}"}\n`;fs.writeFileSync(file,text)
      const event=insertEvent('agent',{subtype:'transcript_snapshot',snapshot_path:file,cumulative_bytes:Buffer.byteLength(text),
        cumulative_sha256:createHash('sha256').update(text).digest('hex')},{engagementId:'eng',operatorId:'op'})!
      if(i===0){firstId=event.id;old=readActivitySnapshot(getReadonlyDB())}lastId=event.id
    }
    expect(searchPage({query:'VERSIONCANARY'}).items.map(e=>e.id)).toEqual([lastId])
    const parsed=parseQuery('VERSIONCANARY');if(!parsed.ok)throw new Error('fixture query failed')
    expect(executeEventQuery({parsed:parsed.parsed,snapshot:old}).items.map(e=>e.id)).toEqual([firstId])
  })

  it('applies target filtering before the page limit and deduplicates metadata matches', () => {
    response('outside', 'needle', 'outside.test')
    const wanted = response('wanted', 'needle', 'wanted.test')
    const page = searchPage({ query: 'needle', targetId: 'wanted.test', limit: 1 })
    expect(page.items.map((event) => event.id)).toEqual([wanted])
  })

  it('removes evicted body content from search', () => {
    const id = response('gone', 'EVICTME-7711')
    const event = searchPage({ query: 'EVICTME-7711', limit: 10 }).items[0]
    expect(event.id).toBe(id)
    const ref = event.data.response_body_ref as { file: string; sha256: string }
    fs.unlinkSync(path.join(dir, 'http-bodies', ref.file))
    pruneHttpBodyIndex(ref.sha256, dir)
    expect(searchPage({ query: 'EVICTME-7711', limit: 10 }).items).toHaveLength(0)
  })

  it('backfills body references created before the derived index existed', () => {
    const text = `${'z'.repeat(5000)} LEGACYBODY-5512`
    const ref = storeBody({ data: text, encoding: 'text', size: text.length, sha256: 'ignored' })!
    const event = insertEvent('scanner', {
      subtype: 'http_response', flow_id: 'legacy', response_body_ref: ref
    }, { engagementId: 'eng', operatorId: 'op', targetId: 'legacy.test' })!

    expect(searchPage({ query: 'LEGACYBODY-5512', limit: 10 }).items.map((item) => item.id)).toEqual([event.id])
  })
})
