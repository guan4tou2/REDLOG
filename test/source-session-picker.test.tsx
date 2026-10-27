// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import SourceSessionPicker from '../src/renderer/src/components/SourceSessionPicker'
import type { SourceSession, SourceSessionPage } from '../src/core/source-sessions'

vi.mock('../src/renderer/src/i18n',()=>({useI18n:()=>({t:(key:string)=>key})}))
afterEach(cleanup)
const snapshot={chainedMaxRowId:1,loggedMaxRowId:0,takenAt:1,chainedCount:1,loggedCount:0,chainedTailId:'a',loggedTailId:null}
const session={projectId:'p',snapshot,token:'selected',source:'claude-code',sessionId:'session',captureSessionId:'capture',anchorEventId:'a',firstAt:1,lastAt:1,eventCount:1} as SourceSession
const page=(items:SourceSession[],extra:Partial<SourceSessionPage>={}):SourceSessionPage=>({snapshot,items,total:items.length,hasMore:false,nextCursor:null,...extra})
function Picker():JSX.Element {
  const [value,setValue]=useState<SourceSession|null>(session)
  return <><SourceSessionPicker kind="agent" value={value} onChange={setValue}/><output>{value?.snapshot.chainedMaxRowId}</output></>
}
it('retains the selected Session on catalog failure and retries explicitly',async()=>{
  const sessions=vi.fn().mockRejectedValueOnce(new Error('catalog unavailable')).mockResolvedValue(page([session]))
  ;(window as any).redlog={config:{get:async()=>({engagement:{id:'p'}})},events:{sourceSessions:sessions,onNewBatch:()=>()=>{}}}
  render(<Picker/> )
  expect((await screen.findByRole('alert')).textContent).toContain('catalog unavailable')
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('selected')
  fireEvent.click(screen.getByRole('button',{name:'common.retry'}))
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull())
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('selected')
})
it('refreshes the selected snapshot even outside the first page and discards an obsolete paging reply',async()=>{
  let notify=()=>{}
  let oldPage!:(value:SourceSessionPage)=>void
  const fresh={...snapshot,chainedMaxRowId:3,chainedCount:3,chainedTailId:'c'}
  const sessions=vi.fn().mockResolvedValueOnce(page([session],{hasMore:true,nextCursor:'next',total:2}))
    .mockImplementationOnce(()=>new Promise<SourceSessionPage>(resolve=>{oldPage=resolve}))
    .mockResolvedValueOnce(page([{...session,token:'other'}],{snapshot:fresh}))
  ;(window as any).redlog={config:{get:async()=>({engagement:{id:'p'}})},events:{sourceSessions:sessions,onNewBatch:(callback:()=>void)=>{notify=callback;return()=>{}}}}
  render(<Picker/> )
  fireEvent.click(await screen.findByRole('button',{name:'workspace.moreSessions'}))
  await act(async()=>notify())
  fireEvent.click(screen.getByRole('button',{name:'workspace.refreshSessions'}))
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('3'))
  await act(async()=>oldPage(page([{...session,token:'obsolete'}])))
  expect(screen.getByRole('status').textContent).toBe('3')
  expect(Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map(option=>option.value)).not.toContain('obsolete')
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('selected')
})
