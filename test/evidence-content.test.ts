import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { searchHttpBodyEventIds, bodySearchCoverage, closeHttpBodyIndex } from '../src/core/http-body-index'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { describeEventContent, readEventContent, findEventContent } from '../src/core/evidence-content'
import type { ContentDescriptor } from '../src/core/content-contract'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-content-')); initDB(dir); })
afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }); })
function event(id: string, data: Record<string, unknown>, tier = 'events'): void {
  getDB().prepare(`INSERT INTO ${tier} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at${tier === 'events' ? ',hash' : ''}) VALUES (?,1,'project','capture','operator','shell','command_end','host',?,1${tier === 'events' ? ",'hash'" : ''})`).run(id, JSON.stringify(data))
}
function body(bytes: Buffer, encoding: 'text' | 'base64' = 'text') {
  const sha256 = createHash('sha256').update(bytes).digest('hex'), file = sha256 + '.body'
  fs.mkdirSync(path.join(dir, 'http-bodies'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'http-bodies', file), bytes)
  return { sha256, file, size: bytes.length, encoding }
}
function descriptor(id: string, field: string): ContentDescriptor {
  const r = describeEventContent('project', id)
  if (!r.ok)
    throw new Error(r.message)
  const d = r.value.find(v => v.field === field)
  if (!d)
    throw new Error('fixture field absent')
  return d
}
describe('saved content windows', () => {
  it('distinguishes empty captured output, absent output and inline JSON without changing Events', () => {
    event('empty', { command: 'id', stdout: '', tool_input: { command: 'id' } })
    const d = descriptor('empty', 'stdout')
    expect(d).toMatchObject({ status: 'available', bytes: 0 })
    expect(readEventContent({ ref: d.ref! })).toMatchObject({ ok: true, value: { text: '', hasMore: false, total: 0 } })
    expect(descriptor('empty', 'stderr').status).toBe('not-captured')
    const input = descriptor('empty', 'tool_input')
    expect(readEventContent({ ref: input.ref! })).toMatchObject({ ok: true, value: { text: '{"command":"id"}', format: 'json' } })
    expect(getDB().prepare('SELECT hash FROM events WHERE id=?').get('empty')).toEqual({ hash: 'hash' })
  })
  it('preserves primitive JSON tool inputs instead of converting booleans to database integers', () => {
    event('boolean', { tool_input: true })
    expect(readEventContent({ ref: descriptor('boolean', 'tool_input').ref! })).toMatchObject({ ok: true, value: { text: 'true', format: 'json' } })
  })
  it('binds Find continuation to its literal query', () => {
    event('query-cursor', { stdout_ref: body(Buffer.from('x'.repeat(2 * 1024 * 1024))) })
    const ref = descriptor('query-cursor', 'stdout').ref!
    const first = findEventContent({ ref, needle: 'absent' })
    if (!first.ok)
      throw new Error(first.message)
    expect(findEventContent({ ref, needle: 'other', cursor: first.value.nextCursor! })).toMatchObject({ ok: false, status: 'changed' })
  })
  it('reads multibyte text across bounded windows and binds cursors to the exact field', () => {
    const text = '中😀abc'.repeat(70), ref = body(Buffer.from(text))
    event('utf8', { stdout_ref: ref, stderr: 'other' })
    const d = descriptor('utf8', 'stdout')
    let cursor
    let out = ''
    do {
      const r = readEventContent({ ref: d.ref!, limit: 7, ...(cursor ? { cursor } : {}) })
      if (!r.ok)
        throw new Error(r.message)
      out += r.value.text
      expect(r.value.end - r.value.offset).toBeLessThanOrEqual(10)
      cursor = r.value.nextCursor
    } while (cursor)
    expect(out).toBe(text)
    expect(out).not.toContain('�')
    expect(readEventContent({ ref: descriptor('utf8', 'stderr').ref!, cursor: { version: d.ref!.version, offset: 7 } })).toMatchObject({ ok: false, status: 'changed' })
  })
  it('finds indexed text at the tail beyond one reader scan budget without treating a scan budget as zero results', () => {
    const text = 'x'.repeat(17 * 1024 * 1024 - 4) + ' needle尾端', ref = body(Buffer.from(text))
    event('large', { stdout_ref: ref })
    expect(searchHttpBodyEventIds('needle尾端')).toEqual(['large'])
    expect(bodySearchCoverage()).toMatchObject({limited:0,indexed:1})
    const d = descriptor('large', 'stdout')
    let cursor
    let pages = 0
    let hit: null | {
      offset: number
      bytes: number
    } = null
    do {
      const r = findEventContent({ ref: d.ref!, needle: 'needle尾端', ...(cursor ? { cursor } : {}) })
      if (!r.ok)
        throw new Error(r.message)
      pages++
      hit = r.value.match
      cursor = r.value.nextCursor
      if (hit)
        break
    } while (cursor)
    expect(pages).toBeGreaterThan(1)
    expect(hit?.offset).toBe(17 * 1024 * 1024 - 3)
    const r = readEventContent({ ref: d.ref!, offset: hit!.offset, limit: 64 })
    expect(r).toMatchObject({ ok: true, value: { text: 'needle尾端', hasMore: false } })
  })
  it('decodes saved base64 output only when its actual bytes are UTF-8 text', () => {
    event('text', { output_body_ref: body(Buffer.from('redlog 輸出'), 'base64') }, 'events_logged')
    const d = descriptor('text', 'output_body')
    expect(d.format).toBe('utf8')
    expect(readEventContent({ ref: d.ref! })).toMatchObject({ ok: true, value: { text: 'redlog 輸出' } })
    event('binary', { stdout_ref: body(Buffer.from([0, 255, 1]), 'base64') })
    const bin = descriptor('binary', 'stdout')
    expect(bin.format).toBe('binary')
    expect(findEventContent({ ref: bin.ref!, needle: 'x' })).toMatchObject({ ok: false, status: 'unsupported' })
  })
  it('rejects missing, replaced, foreign-project and symlinked content instead of returning empty success', () => {
    const ref = body(Buffer.from('original'))
    event('source', { stdout_ref: ref })
    const d = descriptor('source', 'stdout'), file = path.join(dir, 'http-bodies', ref.file), stat = fs.statSync(file)
    fs.writeFileSync(file, 'modified')
    fs.utimesSync(file, stat.atime, stat.mtime)
    expect(readEventContent({ ref: d.ref! })).toMatchObject({ ok: false, status: 'changed' })
    fs.unlinkSync(file)
    expect(readEventContent({ ref: d.ref! })).toMatchObject({ ok: false, status: 'missing' })
    expect(describeEventContent('other', 'source')).toMatchObject({ ok: false, status: 'denied' })
    expect(readEventContent({ ref: { ...d.ref!, projectId: 'other' } })).toMatchObject({ ok: false, status: 'denied' })
  })
  it.skipIf(process.platform === 'win32')('refuses a symlink even when its target has the expected bytes', () => {
    const ref = body(Buffer.from('original'))
    event('link', { stdout_ref: ref })
    const d = descriptor('link', 'stdout'), file = path.join(dir, 'http-bodies', ref.file)
    fs.unlinkSync(file)
    const outside = path.join(dir, 'outside')
    fs.writeFileSync(outside, 'original')
    fs.symlinkSync(outside, file)
    expect(readEventContent({ ref: d.ref! })).toMatchObject({ ok: false, status: 'denied' })
    fs.rmSync(path.join(dir,'http-bodies'),{recursive:true,force:true})
    const external=path.join(dir,'external-bodies');fs.mkdirSync(external)
    fs.writeFileSync(path.join(external,ref.file),'original')
    fs.symlinkSync(external,path.join(dir,'http-bodies'),'dir')
    expect(readEventContent({ref:d.ref!})).toMatchObject({ok:false,status:'denied'})
  })
  it('searches decoded UTF-8 stdout stored as base64, without indexing binary bytes as text', () => {
    event('decoded', { stdout_ref: body(Buffer.from('needleSecret'), 'base64') })
    event('binary-index', { stdout_ref: body(Buffer.from([0, 255, 1]), 'base64') })
    expect(searchHttpBodyEventIds('needleSecret')).toEqual(['decoded'])
    expect(bodySearchCoverage()).toMatchObject({ indexed: 1, binary: 1, pending: 0 })
  })
  it('removes stale indexed text when the saved file disappears and indexes a restored file', () => {
    const ref = body(Buffer.from('needleSecret'))
    event('saved', { stdout_ref: ref })
    expect(searchHttpBodyEventIds('needleSecret')).toEqual(['saved'])
    const file = path.join(dir, 'http-bodies', ref.file)
    fs.unlinkSync(file)
    expect(searchHttpBodyEventIds('needleSecret')).toEqual([])
    expect(bodySearchCoverage()).toMatchObject({ missing: 1, indexed: 0 })
    fs.writeFileSync(file, 'needleSecret')
    expect(searchHttpBodyEventIds('needleSecret')).toEqual(['saved'])
  })
  it('does not silently advance beyond a missing body that arrives later', () => {
    const ref = body(Buffer.from('laterNeedle')), file = path.join(dir, 'http-bodies', ref.file)
    fs.unlinkSync(file)
    event('delayed', { stdout_ref: ref })
    expect(searchHttpBodyEventIds('laterNeedle')).toEqual([])
    fs.writeFileSync(file, 'laterNeedle')
    expect(searchHttpBodyEventIds('laterNeedle')).toEqual(['delayed'])
  })
  it('refuses stale search hits after a same-size body rewrite', () => {
    const ref = body(Buffer.from('needleSecret'))
    event('rewrite', { stdout_ref: ref })
    expect(searchHttpBodyEventIds('needleSecret')).toEqual(['rewrite'])
    const file = path.join(dir, 'http-bodies', ref.file), stat = fs.statSync(file)
    fs.writeFileSync(file, 'other-Secret')
    fs.utimesSync(file, stat.atime, stat.mtime)
    event('valid-after-damage',{stdout_ref:body(Buffer.from('validNeedle'))})
    expect(searchHttpBodyEventIds('needleSecret')).toEqual([])
    expect(bodySearchCoverage()).toMatchObject({failed:1,indexed:1})
    expect(searchHttpBodyEventIds('validNeedle')).toEqual(['valid-after-damage'])
  })
})

describe('precise saved-content anchors',()=>{
  it('resolves a single byte and reports a removed sidecar without substituting text',async()=>{
    const {createContentAnchor,resolveContentAnchor}=await import('../src/core/evidence-content')
    const saved=body(Buffer.from('abc')); event('tiny-fragment',{stdout_ref:saved})
    const ref=descriptor('tiny-fragment','stdout').ref!
    const anchor=createContentAnchor({ref:{...ref,extra:'must not persist'} as typeof ref,start:1,end:2})
    if(!anchor.ok)throw new Error(anchor.message)
    expect(anchor.value.ref).toEqual(ref)
    expect(resolveContentAnchor(anchor.value)).toMatchObject({ok:true,value:{text:'b',offset:1}})
    fs.unlinkSync(path.join(dir,'http-bodies',saved.file))
    expect(resolveContentAnchor(anchor.value)).toMatchObject({ok:false,status:'missing'})
  })
  it('uses UTF-8 bytes for emoji/CRLF/ANSI and refuses a replaced source',async()=>{
    const {createContentAnchor,resolveContentAnchor}=await import('../src/core/evidence-content')
    const text='前🙂\r\n\x1b[31msecret\x1b[0m尾'
    const saved=body(Buffer.from(text)); event('anchored',{stdout_ref:saved})
    const ref=descriptor('anchored','stdout').ref!
    const start=Buffer.byteLength('前🙂\r\n'),end=start+Buffer.byteLength('\x1b[31msecret\x1b[0m')
    const anchor=createContentAnchor({ref,start,end})
    expect(anchor.ok).toBe(true)
    if(!anchor.ok)throw new Error(anchor.message)
    expect(anchor.value).not.toHaveProperty('excerpt')
    expect(resolveContentAnchor(anchor.value)).toMatchObject({ok:true,value:{text:'\x1b[31msecret\x1b[0m',offset:start}})
    expect(resolveContentAnchor({...anchor.value,sha256:'0'.repeat(64)})).toMatchObject({ok:false})
    fs.writeFileSync(path.join(dir,'http-bodies',saved.file),'replacement')
    expect(resolveContentAnchor(anchor.value)).toMatchObject({ok:false,status:'changed'})
  })
  it('rejects split codepoints, excessive selections and different-project references',async()=>{
    const {createContentAnchor}=await import('../src/core/evidence-content')
    event('anchor-limits',{stdout:'🙂'+ 'x'.repeat(20000)})
    const ref=descriptor('anchor-limits','stdout').ref!
    expect(createContentAnchor({ref,start:1,end:3})).toMatchObject({ok:false})
    expect(createContentAnchor({ref,start:0,end:18000})).toMatchObject({ok:false})
    expect(createContentAnchor({ref:{...ref,projectId:'other'},start:0,end:4})).toMatchObject({ok:false,status:'denied'})
  })
})

describe('complete saved-content delivery',()=>{
  it('copies the saved version, refuses oversized/binary clipboard payloads and rejects stale references',async()=>{
    const {readContentForClipboard}=await import('../src/core/evidence-content')
    const saved=body(Buffer.from('前🙂\r\nsecret')); event('copy-all',{stdout_ref:saved})
    const ref=descriptor('copy-all','stdout').ref!
    expect(readContentForClipboard(ref)).toMatchObject({ok:true,value:{text:'前🙂\r\nsecret'}})
    event('copy-large',{stdout_ref:body(Buffer.alloc(1024*1024+1,97))})
    expect(readContentForClipboard(descriptor('copy-large','stdout').ref!)).toMatchObject({ok:false,status:'unsupported',message:'clipboard-limit'})
    event('copy-binary',{stdout_ref:body(Buffer.from([0,255,3]))})
    expect(readContentForClipboard(descriptor('copy-binary','stdout').ref!)).toMatchObject({ok:false,status:'unsupported'})
    fs.unlinkSync(path.join(dir,'http-bodies',saved.file))
    expect(readContentForClipboard(ref)).toMatchObject({ok:false,status:'missing'})
  })
  it('saves all bytes in bounded windows, never overwrites evidence or existing files, and cleans failed deliveries',async()=>{
    const {saveEventContent}=await import('../src/core/saved-content-delivery')
    const output=fs.mkdtempSync(dir+'-delivery-')
    try{
      const bytes=Buffer.from(('前🙂\r\n\x1b[31msecret\x1b[0m').repeat(10000))
      const stored=body(bytes);event('save-all',{stdout_ref:stored})
      const ref=descriptor('save-all','stdout').ref!,dest=path.join(output,'saved.txt')
      expect(await saveEventContent(ref,dest,()=>true)).toMatchObject({ok:true,value:{bytes:bytes.length,path:dest}})
      expect(fs.readFileSync(dest)).toEqual(bytes)
      expect((await saveEventContent(ref,dest,()=>true)).ok).toBe(false)
      expect(fs.readFileSync(dest)).toEqual(bytes)
      expect((await saveEventContent(ref,path.join(dir,'new-evidence.txt'),()=>true)).ok).toBe(false)
      let checks=0
      const refused=path.join(output,'refused.txt')
      expect(await saveEventContent(ref,refused,()=>++checks<3)).toMatchObject({ok:false,status:'denied'})
      expect(fs.existsSync(refused)).toBe(false)
      const changed=path.join(output,'changed.txt')
      let changedChecks=0
      expect(await saveEventContent(ref,changed,()=>{if(++changedChecks===3)fs.writeFileSync(path.join(dir,'http-bodies',stored.file),'replaced');return true})).toMatchObject({ok:false,status:'changed'})
      expect(fs.existsSync(changed)).toBe(false)
      event('binary-save',{stdout_ref:body(Buffer.from([0,255,3]))})
      const binary=path.join(output,'saved.bin')
      expect((await saveEventContent(descriptor('binary-save','stdout').ref!,binary,()=>true)).ok).toBe(true)
      expect(fs.readFileSync(binary)).toEqual(Buffer.from([0,255,3]))
      const failed=path.join(output,'write-failed.bin')
      const write=vi.spyOn(fs,'writeSync').mockImplementationOnce(()=>{throw new Error('synthetic write failure')})
      try{expect(await saveEventContent(descriptor('binary-save','stdout').ref!,failed,()=>true)).toMatchObject({ok:false,status:'failed'})}
      finally{write.mockRestore()}
      expect(fs.existsSync(failed)).toBe(false)
    }finally{fs.rmSync(output,{recursive:true,force:true})}
  })
})
