// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'
import { EventContentReader } from '../src/renderer/src/components/EventContentReader'
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: {
    text: string
  }) => <button>{text}</button> }))
afterEach(cleanup)
it('opens a saved field, pages without losing the first window, and preserves it on read failure', async () => {
  const ref = { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' }
  const read = vi.fn().mockResolvedValueOnce({ ok: true, value: { offset: 0, end: 4, total: 8, text: 'head', format: 'utf8', hasMore: true, nextCursor: { version: 'v', offset: 4 } } }).mockResolvedValueOnce({ ok: false, status: 'missing', message: 'removed' })
  ;(window as any).redlog = { content: { list: vi.fn().mockResolvedValue({ ok: true, value: [{ field: 'stdout', status: 'available', ref, bytes: 8, format: 'utf8', capture: 'unknown' }] }), read, find: vi.fn() } }
  render(<EventContentReader projectId="p" eventId="e"/>)
  await screen.findByText('head', { selector: 'pre' })
  fireEvent.click(screen.getByRole('button', { name: 'content.next' }))
  await screen.findByRole('alert')
  expect(screen.getByText('head', { selector: 'pre' })).toBeTruthy()
  expect(read.mock.calls[1][0].cursor).toEqual({ version: 'v', offset: 4 })
})
it('continues a bounded Find until the actual hit, then opens its byte offset', async () => {
  const ref = { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' }
  const read = vi.fn().mockImplementation(({ offset = 0 }: {offset?: number}) => Promise.resolve({ ok: true, value: { offset, end: offset + 4, total: 2000000, text: 'head', format: 'utf8', hasMore: false, nextCursor: null } }))
  const find = vi.fn().mockResolvedValueOnce({ ok: true, value: { match: null, hasMore: true, nextCursor: { version: 'v', offset: 1000000, query: 'q' } } }).mockResolvedValueOnce({ ok: true, value: { match: { offset: 1500000, bytes: 6 }, hasMore: false, nextCursor: null } })
  ;(window as any).redlog = { content: { list: vi.fn().mockResolvedValue({ ok: true, value: [{ field: 'stdout', status: 'available', ref, bytes: 2000000, format: 'utf8', capture: 'unknown' }] }), read, find } }
  render(<EventContentReader projectId="p" eventId="e"/>)
  await screen.findByText('head', { selector: 'pre' })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle' } })
  fireEvent.click(screen.getByRole('button', { name: 'content.find' }))
  await waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({ offset: 1500000 })))
  expect(find).toHaveBeenCalledTimes(2)
  const previous = screen.getByRole('button', {name:'content.previous'}) as HTMLButtonElement
  expect(previous.disabled).toBe(false)
  fireEvent.click(previous)
  await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({offset:1500000-65536})))
})

it('refreshes the query instead of retrying an invalidated pagination cursor forever', async () => {
  const event={id:'source',timestamp:1,agentType:'shell',data:{command:'id',subtype:'command_end',exit_code:0}}
  const item={id:'activity',kind:'command',toolAction:'unknown',provider:null,firstAt:1,anchor:event,matchedCount:1,contextCount:0}
  const page={items:[item],hasMore:true,nextCursor:'old-cursor',totalGroups:2,totalMatches:2,snapshot:{}}
  const activityPage=vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('index coverage changed')).mockResolvedValueOnce({...page,hasMore:false,nextCursor:null})
  ;(window as any).redlog={config:{get:vi.fn().mockResolvedValue({engagement:{id:'p'}})},events:{onNewBatch:()=>()=>{},activityPage}}
  render(<ActivityResults request={{parsed:{text:'id',conditions:[],tokens:[]}} as any}/>)
  fireEvent.click(await screen.findByRole('button',{name:'search.loadMore'}))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button',{name:'activity.refresh'}))
  await waitFor(()=>expect(activityPage).toHaveBeenCalledTimes(3))
  expect(activityPage.mock.calls[1][0]).toHaveProperty('cursor','old-cursor')
  expect(activityPage.mock.calls[2][0]).not.toHaveProperty('cursor')
})

it('keeps the open source and its reading position when another source page arrives', async () => {
  const start={id:'start',timestamp:1,agentType:'shell',data:{command:'id',subtype:'command_start'}}
  const end={...start,id:'end',timestamp:2,data:{command:'id',subtype:'command_end',exit_code:0}}
  const item={id:'activity',kind:'command',toolAction:'unknown',provider:null,firstAt:1,anchor:start,matchedCount:2,contextCount:0}
  const first={items:[{event:start,matched:true}],hasMore:true,nextCursor:'source-next',sourceCount:2,matchedCount:2,snapshot:{}}
  const activityMembers=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({...first,items:[{event:end,matched:true}],hasMore:false,nextCursor:null})
  ;(window as any).redlog={
    config:{get:vi.fn().mockResolvedValue({engagement:{id:'p'}})},
    events:{onNewBatch:()=>()=>{},activityPage:vi.fn().mockResolvedValue({items:[item],hasMore:false,totalGroups:1,totalMatches:2,snapshot:{}}),activityMembers},
    content:{
      list:vi.fn().mockImplementation(({eventId})=>Promise.resolve({ok:true,value:[{field:'stdout',status:'available',ref:{projectId:'p',eventId,field:'stdout',version:eventId},bytes:5,format:'utf8',capture:'unknown'}]})),
      read:vi.fn().mockImplementation(({ref})=>Promise.resolve({ok:true,value:{offset:0,end:5,total:5,text:ref.eventId==='start'?'input':'later result',format:'utf8',hasMore:false,nextCursor:null}}))
    }
  }
  render(<ActivityResults request={{parsed:{text:'id',conditions:[],tokens:[]}} as any}/>)
  fireEvent.click(await screen.findByTestId('activity-row'))
  await screen.findByText('input',{selector:'pre'})
  fireEvent.click(screen.getByRole('button',{name:'activity.moreSources'}))
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'activity.sourceEvent'}).querySelectorAll('option')).toHaveLength(2))
  expect((screen.getByRole('combobox',{name:'activity.sourceEvent'}) as HTMLSelectElement).value).toBe('start')
  expect(screen.getByText('input',{selector:'pre'})).toBeTruthy()
})

it('restores each content field window and Find input after switching stdout and stderr', async () => {
  const fields = ['stdout', 'stderr'].map(field => ({ field, status: 'available', ref: { projectId: 'p', eventId: 'e', field, version: field }, bytes: 8, format: 'utf8', capture: 'unknown' }))
  const read = vi.fn().mockImplementation(({ref, cursor}: any) => Promise.resolve({ok:true,value:{offset:cursor?.offset ?? 0,end:cursor ? 8 : 4,total:8,text:`${ref.field}-${cursor ? 'tail' : 'head'}`,format:'utf8',hasMore:!cursor,nextCursor:cursor ? null : {version:ref.version,offset:4}}}))
  ;(window as any).redlog = { content: {list: vi.fn().mockResolvedValue({ok:true,value:fields}),read,find:vi.fn()} }
  render(<EventContentReader projectId="p" eventId="e" />)
  await screen.findByText('stdout-head',{selector:'pre'})
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'remember'}})
  fireEvent.click(screen.getByRole('button',{name:'content.next'}))
  await screen.findByText('stdout-tail',{selector:'pre'})
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'stderr'}})
  await screen.findByText('stderr-head',{selector:'pre'})
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'stdout'}})
  expect(screen.getByRole('searchbox')).toHaveProperty('value','remember')
  expect(screen.getByText('stdout-tail',{selector:'pre'}).closest('[hidden]')).toBeNull()
  expect(read).toHaveBeenCalledTimes(3)
})
