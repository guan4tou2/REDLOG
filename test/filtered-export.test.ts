import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))
import { initDB, closeDB } from '../src/core/db/index'
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
 { getActiveProject: () => ({ id: 'filtered', path: dir }) } as never)
})
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
const resolve = (request: unknown) => handlers.get('data:resolveExportPlan')!({}, request)
const execute = (id: string) => handlers.get('data:executeExportPlan')!({}, { planId: id })
it('exports all matching rows beyond the screen page and freezes preview membership', () => {
 for (let i = 0; i < 520; i++) addExportEvent('events_logged', `match-${i}`, 1000+i, 'EXAMPLE.COM', { subtype: 'command', command: 'canary' })
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
 for(let i=0;i<505;i++) {
  addExportEvent('events_logged',`req-${i}`,1000+i,'example.com',{subtype:'http_request_start',flow_id:`f-${i}`,method:'GET',url:'https://example.com/needle',host:'example.com'})
  addExportEvent('events_logged',`res-${i}`,9000+i,'example.com',{subtype:'http_response',flow_id:`f-${i}`,status:404,content_type:'text/plain'})
 }
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
