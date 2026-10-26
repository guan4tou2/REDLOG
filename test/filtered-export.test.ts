import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { queryActivityPage } from '../src/core/db/activity-queries'
import { parseQuery } from '../src/core/query/contract'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { addExportEvent as insertFixture } from './helpers/export-fixtures'
function addExportEvent(table: 'events' | 'events_logged', id: string, ts: number, targetId: string, data: Record<string, unknown> = {}): void {
 insertFixture(table, id, ts, { targetId, agentType: String(data.subtype ?? '').startsWith('http_') ? 'scanner' : 'shell', subtype: String(data.subtype ?? 'command_end'), data })
}
let dir: string
let handlers: Map<string, (...args: any[]) => any>
beforeEach(() => {
 dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filtered-export-')); initDB(dir)
 handlers = new Map()
 registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as never,
 { getActiveProject: () => ({ id: 'eng-1', path: dir }) } as never)
})
// closeDB() does not close the body index — it holds its own handle, and on
// Windows that keeps http-body-index.db locked, so the rmSync below throws
// EBUSY and fails a test whose assertions all passed.
afterEach(() => { closeDB(); closeHttpBodyIndex(); fs.rmSync(dir, { recursive: true, force: true }) })
const resolve = (request: unknown) => handlers.get('data:resolveExportPlan')!({}, request)
const execute = (id: string) => handlers.get('data:executeExportPlan')!({}, { planId: id })
it('exports all matching rows beyond the screen page and freezes preview membership', () => {
 getDB().transaction(() => {
  for (let i = 0; i < 520; i++) addExportEvent('events_logged', `match-${i}`, 1000+i, 'EXAMPLE.COM', { subtype: 'command', command: 'canary' })
 })()
 addExportEvent('events', 'wrong', 1300, 'other.test')
 const r=resolve({format:'json',subset:{kind:'selection',projection:'events',filter:{targetId:'example.com'},query:'canary'}})
 expect(r.ok).toBe(true); expect(r.plan.counts.included).toBe(520)
 addExportEvent('events_logged','late',1200,'example.com',{command:'canary'})
 const result=execute(r.plan.id); expect(result.ok).toBe(true)
 expect(JSON.parse(fs.readFileSync(result.artifactPath,'utf8')).events).toHaveLength(520)
})
it('invalid typed query and unknown selection kind fail rather than export everything', () => {
 expect(resolve({format:'json',subset:{kind:'selection',projection:'events',filter:{},query:'session:'}}).ok).toBe(false)
 expect(resolve({format:'json',subset:{kind:'typo'}}).ok).toBe(false)
})
it('HTTP predicates select complete exchanges before pagination and response-time bounds', () => {
 getDB().transaction(() => {
 for(let i=0;i<505;i++) {
  addExportEvent('events_logged',`req-${i}`,1000+i,'example.com',{subtype:'http_request_start',flow_id:`f-${i}`,method:'GET',url:'https://example.com/needle',host:'example.com'})
  addExportEvent('events_logged',`res-${i}`,9000+i,'example.com',{subtype:'http_response',flow_id:`f-${i}`,status:404,content_type:'text/plain'})
 }
 })()
 addExportEvent('events_logged','unrelated',1200,'example.com',{subtype:'http_request_start',flow_id:'no',method:'POST',url:'https://example.com/needle'})
 const r=resolve({format:'har',maskOutOfScope:false,subset:{kind:'selection',projection:'http',filter:{since:1000,before:1600},http:{method:'GET',statusPrefix:'4',host:'example.com',text:'needle'}}})
 expect(r.ok).toBe(true); expect(r.plan.counts.included).toBe(1010)
 const result=execute(r.plan.id); expect(result.ok).toBe(true)
 const entries=JSON.parse(fs.readFileSync(result.artifactPath,'utf8')).log.entries
 expect(entries).toHaveLength(505); expect(entries.every((e:any)=>e.response.status===404)).toBe(true)
})
it('retains response-only provenance and rejects incompatible HTTP tier/type without widening', () => {
 addExportEvent('events_logged','response',1000,'example.com',{subtype:'http_response',flow_id:'orphan',status:503,method:'GET',host:'example.com',url:'https://example.com/orphan'})
 const subset={kind:'selection',projection:'http',filter:{},http:{statusPrefix:'5'}}
 const r=resolve({format:'har',subset}); expect(r.plan.counts.exchanges).toBe(1)
 const file=execute(r.plan.id).artifactPath
 const entry=JSON.parse(fs.readFileSync(file,'utf8')).log.entries[0]
 expect(entry._redlog).toMatchObject({requestEventId:null,responseEventId:'response',incomplete:true})
 for (const filter of [{tier:'chained'},{agentType:'shell'}]) {
  const empty=resolve({format:'har',subset:{...subset,filter}})
  expect(empty.ok).toBe(true); expect(empty.plan.counts.included).toBe(0)
 }
})
it('chooses latest response for HTTP status and freezes late response updates', () => {
 addExportEvent('events_logged','request',1000,'example.com',{subtype:'http_request_start',flow_id:'repeat',method:'GET',host:'example.com',url:'https://example.com/'})
 addExportEvent('events_logged','old-response',2000,'example.com',{subtype:'http_response',flow_id:'repeat',status:302})
 addExportEvent('events_logged','new-response',3000,'example.com',{subtype:'http_response',flow_id:'repeat',status:200})
 const r=resolve({format:'har',subset:{kind:'selection',projection:'http',filter:{},http:{statusPrefix:'2'}}})
 expect(r.ok).toBe(true)
 addExportEvent('events_logged','after-preview',4000,'example.com',{subtype:'http_response',flow_id:'repeat',status:500})
 const entry=JSON.parse(fs.readFileSync(execute(r.plan.id).artifactPath,'utf8')).log.entries[0]
 expect(entry.response.status).toBe(200)
 expect(entry._redlog.responseEventId).toBe('new-response')
})

it('exports every long-command companion beyond the preview limit, at the approved snapshot', () => {
 addExportEvent('events','long-end',100,'example.com',{subtype:'command_end',command:'long-canary',command_id:'long-command',late_output:true})
 // Seed one immutable dataset; independent fsyncs are not the export contract.
 getDB().transaction(() => {
  for(let seq=1;seq<=2005;seq++) addExportEvent(seq%2?'events':'events_logged',`chunk-${seq}`,100+seq,'example.com',{subtype:'command_output',command_id:'long-command',late:true,seq,stdout:`line-${seq}\n`})
 })()
 const r=resolve({format:'json',subset:{kind:'selection',projection:'events',filter:{},query:'long-canary',excludeHousekeeping:true}})
 expect(r.ok).toBe(true)
 expect(r.plan.counts.included).toBe(2006)
 addExportEvent('events','after-preview-duplicate',1,'example.com',{subtype:'command_output',command_id:'long-command',late:true,seq:1,stdout:'must not replace the approved chunk'})
 addExportEvent('events','after-preview',9999,'example.com',{subtype:'command_output',command_id:'long-command',late:true,seq:2006,stdout:'not approved'})
 const result=execute(r.plan.id); expect(result.ok).toBe(true)
 const exported=JSON.parse(fs.readFileSync(result.artifactPath,'utf8')).events
 expect(exported).toHaveLength(2006)
 expect(exported.some((e:any)=>e.id==='chunk-2005')).toBe(true)
 expect(exported.some((e:any)=>e.id==='after-preview')).toBe(false)
})

function activityFixture() {
 const payload={shell:'zsh',terminalId:'term-one',command_id:'command-one',command:'unique-op'}
 addExportEvent('events','begin',10,'a.test',{...payload,subtype:'command_start'})
 addExportEvent('events','end',20,'a.test',{...payload,subtype:'command_end',stdout:'saved output',io:{ref:'casts/session.cast'}})
 addExportEvent('events_logged','chunk',21,'a.test',{...payload,subtype:'command_output',stdout:'late output'})
 addExportEvent('events','same-session',30,'b.test',{...payload,command_id:'command-two',subtype:'command_end',io:{ref:'casts/session.cast'}})
 addExportEvent('events','other-session',40,'a.test',{...payload,terminalId:'term-two',subtype:'command_end'})
 const parsed=parseQuery('unique-op'); if(!parsed.ok) throw new Error('query')
 const page=queryActivityPage({projectId:'eng-1',parsed:parsed.parsed})
 return {snapshot:page.snapshot,anchorEventId:'begin',projectId:'eng-1'}
}
it('exports an Activity with all companions, freezing late arrivals before preview',()=>{
 const selected=activityFixture()
 addExportEvent('events','after-list',5,'a.test',{shell:'zsh',terminalId:'term-one',command_id:'command-one',subtype:'command_output',stdout:'not reviewed'})
 const r=resolve({format:'json',maskOutOfScope:false,subset:{kind:'activity',...selected}})
 expect(r.ok).toBe(true); expect(r.plan.counts.included).toBe(3)
 const out=execute(r.plan.id); expect(out.ok).toBe(true)
 expect(JSON.parse(fs.readFileSync(out.artifactPath,'utf8')).events.map((e:any)=>e.id).sort()).toEqual(['begin','chunk','end'])
})
it('exports only the anchored source Session within the capture namespace',()=>{
 const selected=activityFixture()
 const r=resolve({format:'json',maskOutOfScope:false,subset:{kind:'session',...selected}})
 expect(r.ok).toBe(true); expect(r.plan.counts.included).toBe(4)
 const out=execute(r.plan.id);expect(out.ok).toBe(true)
 expect(JSON.parse(fs.readFileSync(out.artifactPath,'utf8')).events.some((e:any)=>e.id==='other-session')).toBe(false)
 const nd=resolve({format:'ndjson',maskOutOfScope:false,subset:{kind:'session',...selected}})
 const ndOut=execute(nd.plan.id); expect(ndOut.ok).toBe(true)
 const lines=fs.readFileSync(ndOut.artifactPath,'utf8').trim().split('\n').map(line=>JSON.parse(line))
 expect(lines.map(e=>e.id).sort()).toEqual(['begin','chunk','end','same-session'])
 expect(resolve({format:'json',subset:{kind:'session',...selected,projectId:'different'}}).ok).toBe(false)
})
it('does not silently add cross-target casts or unrelated screenshots to a bounded bundle',()=>{
 const selected=activityFixture()
 fs.mkdirSync(path.join(dir,'casts'));fs.mkdirSync(path.join(dir,'screenshots'),{recursive:true})
 fs.writeFileSync(path.join(dir,'casts','session.cast'),'{}\n[0,"o","content"]\n')
 fs.writeFileSync(path.join(dir,'screenshots','private.jpg'),'unrelated')
 // The capture reference was present when the operator opened the operation.
 const subset={kind:'activity',...selected}
 const r=resolve({format:'bundle',maskOutOfScope:false,subset})
 expect(r.ok).toBe(true)
 expect(r.plan.attachments.some((a:any)=>a.id==='screenshots/private.jpg')).toBe(false)
 expect(r.plan.attachments.find((a:any)=>a.kind==='cast')).toMatchObject({status:'excluded-by-policy',attribution:'cross-target',targets:['a.test','b.test']})
 const explicit=resolve({format:'bundle',maskOutOfScope:false,subset,includeAttachments:['casts/session.cast']})
 expect(explicit.ok).toBe(true)
 expect(explicit.plan.attachments.find((a:any)=>a.kind==='cast').status).toBe('included')
 const out=execute(r.plan.id); expect(out.ok).toBe(true)
 expect(fs.existsSync(path.join(out.artifactPath,'casts','session.cast'))).toBe(false)
})

it('invalidates a reviewed operation when an event is marked private before execution',()=>{
 const selected=activityFixture()
 const r=resolve({format:'json',subset:{kind:'activity',...selected}})
 expect(r.ok).toBe(true)
 getDB().prepare('INSERT INTO do_not_export(event_id,created_at) VALUES(?,?)').run('end',Date.now())
 expect(execute(r.plan.id)).toMatchObject({ok:false,error:'policy-changed'})
})
it('freezes selected cast prefixes and parts while a source session keeps recording',()=>{
 const selected=activityFixture()
 fs.mkdirSync(path.join(dir,'casts'))
 const first=path.join(dir,'casts','session.cast')
 fs.writeFileSync(first,'{}\n[0,"o","reviewed"]\n')
 const reviewed=fs.readFileSync(first,'utf8')
 const r=resolve({format:'bundle',maskOutOfScope:false,subset:{kind:'session',...selected},includeAttachments:['casts/session.cast']})
 expect(r.ok).toBe(true)
 fs.appendFileSync(first,'[1,"o","not reviewed"]\n')
 fs.writeFileSync(path.join(dir,'casts','session.part000001.cast'),'{}\n[2,"o","new part"]\n')
 const out=execute(r.plan.id);expect(out.ok).toBe(true)
 expect(fs.readFileSync(path.join(out.artifactPath,'casts','session.cast'),'utf8')).toBe(reviewed)
 expect(fs.existsSync(path.join(out.artifactPath,'casts','session.part000001.cast'))).toBe(false)
})

it('rejects bytes changed during bundle copying rather than declaring a successful delivery',()=>{
 const selected=activityFixture()
 fs.mkdirSync(path.join(dir,'casts'))
 fs.writeFileSync(path.join(dir,'casts','session.cast'),'{}\n[0,"o","reviewed"]\n')
 const r=resolve({format:'bundle',maskOutOfScope:false,subset:{kind:'activity',...selected},includeAttachments:['casts/session.cast']})
 expect(r.ok).toBe(true)
 const original=fs.copyFileSync
 const copy=vi.spyOn(fs,'copyFileSync').mockImplementation((source,destination,mode)=>{
   original(source,destination,mode)
   if(String(source).endsWith('session.cast')) fs.writeFileSync(destination,fs.readFileSync(destination,'utf8').replace('reviewed','MODIFIED'))
 })
 try { expect(execute(r.plan.id)).toMatchObject({ok:false,error:'source-unavailable'}) }
 finally { copy.mockRestore() }
})

it('keeps Claude Code and Codex sessions separate even when their session names collide',()=>{
 for(const [id,provider,subtype] of [
  ['claude-prompt','claude-code','user_message'],['claude-answer','claude-code','assistant_message'],['codex-prompt','codex','user_message']
 ]) insertFixture('events',id,10,{agentType:'agent',subtype,data:{agent:provider,session_id:'shared-name',message:'synthetic'}})
 const parsed=parseQuery('');if(!parsed.ok) throw new Error('query')
 const snapshot=queryActivityPage({projectId:'eng-1',parsed:parsed.parsed}).snapshot
 const r=resolve({format:'json',subset:{kind:'session',projectId:'eng-1',anchorEventId:'claude-prompt',snapshot}})
 expect(r.ok).toBe(true);expect(r.plan.counts.included).toBe(2)
 const out=execute(r.plan.id);expect(out.ok).toBe(true)
 expect(JSON.parse(fs.readFileSync(out.artifactPath,'utf8')).events.map((e:any)=>e.id).sort()).toEqual(['claude-answer','claude-prompt'])
})
