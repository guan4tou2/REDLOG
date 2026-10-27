import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const mocks=vi.hoisted(()=>({writeText:vi.fn(),showSaveDialog:vi.fn()}))
vi.mock('electron',()=>({clipboard:{writeText:mocks.writeText},dialog:{showSaveDialog:mocks.showSaveDialog}}))
import {initDB,closeDB} from '../src/core/db/index'
import {insertEvent} from '../src/core/db/events'
import {describeEventContent} from '../src/core/evidence-content'
import {registerEventsIpc} from '../src/main/ipc/events'
import type {IpcContext} from '../src/main/ipc/types'
let dir:string,owner:string|null
let handlers:Map<string,(_event:unknown,...args:any[])=>any>
beforeEach(()=>{
  vi.resetAllMocks();dir=fs.mkdtempSync(path.join(os.tmpdir(),'redlog-content-ipc-'));initDB(dir);owner='eng'
  handlers=new Map()
  registerEventsIpc({handle:(name:string,fn:any)=>handlers.set(name,fn)} as never,{getActiveProject:()=>owner?{id:owner,path:dir}:null,getCurrentEngagementId:()=>owner,getMainWindow:()=>null} as IpcContext)
})
afterEach(()=>{closeDB();fs.rmSync(dir,{recursive:true,force:true})})
function ref(){
  const event=insertEvent('shell',{subtype:'command_end',stdout:'saved output'},{engagementId:'eng',operatorId:'op'})!
  const fields=describeEventContent('eng',event.id);if(!fields.ok)throw new Error(fields.message)
  return fields.value.find(field=>field.field==='stdout')!.ref!
}
it('copies only an available current-project version and reports clipboard failure',()=>{
  const source=ref(),copy=handlers.get('content:copySaved')!
  expect(copy({},source)).toMatchObject({ok:true,value:{bytes:12}})
  expect(mocks.writeText).toHaveBeenCalledWith('saved output')
  mocks.writeText.mockImplementationOnce(()=>{throw new Error('clipboard unavailable')})
  expect(copy({},source)).toMatchObject({ok:false,status:'failed'})
  expect(copy({},{...source,projectId:'other'})).toMatchObject({ok:false,status:'denied'})
  expect(mocks.writeText).toHaveBeenCalledTimes(2)
})
it('checks ownership before the dialog, treats cancel as cancel, and rechecks after project changes',async()=>{
  const source=ref(),save=handlers.get('content:save')!
  expect(await save({},{...source,projectId:'other'})).toMatchObject({ok:false,status:'denied'})
  expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  mocks.showSaveDialog.mockResolvedValueOnce({canceled:true})
  expect(await save({},source)).toEqual({ok:true,value:null})
  const destination=path.join(dir,'never-created.txt')
  mocks.showSaveDialog.mockImplementationOnce(async()=>{owner='other';return {canceled:false,filePath:destination}})
  expect(await save({},source)).toMatchObject({ok:false,status:'denied'})
  expect(fs.existsSync(destination)).toBe(false)
})
