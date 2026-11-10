// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import SourceSessionPicker from '../src/renderer/src/components/SourceSessionPicker'
import { I18nProvider } from '../src/renderer/src/i18n'
import { setDisplayZone } from '../src/renderer/src/lib/time'
import type { SourceSession, SourceSessionPage, SourceSessionRequest } from '../src/core/source-sessions'

beforeEach(() => setDisplayZone('utc'))
afterEach(cleanup)
const snapshot={chainedMaxRowId:1,loggedMaxRowId:0,takenAt:1,chainedCount:1,loggedCount:0,chainedTailId:'a',loggedTailId:null}
const at=Date.UTC(2026,10,9,15,42)
const session={projectId:'p',snapshot,token:'selected',source:'claude-code',sessionId:'session',captureSessionId:'capture',anchorEventId:'a',firstAt:at,lastAt:at,eventCount:38} as SourceSession
const page=(items:SourceSession[],extra:Partial<SourceSessionPage>={}):SourceSessionPage=>({snapshot,items,total:items.length,hasMore:false,nextCursor:null,...extra})
const make=(i:number):SourceSession=>({...session,token:`t${i}`,sessionId:`conv-${String(i).padStart(2,'0')}`,captureSessionId:`capture-${i}`,lastAt:at-i*60_000,eventCount:i+1})
function bridge(sourceSessions:(req:SourceSessionRequest)=>Promise<SourceSessionPage>,onNewBatch:(callback:()=>void)=>()=>void=()=>()=>{}):void {
  ;(window as any).redlog={config:{get:async()=>({engagement:{id:'p'}})},events:{sourceSessions,onNewBatch}}
}
function Picker({kind='agent',initial=session}:{kind?:'agent'|'shell';initial?:SourceSession|null}):JSX.Element {
  const [value,setValue]=useState<SourceSession|null>(initial)
  return <I18nProvider><SourceSessionPicker kind={kind} value={value} onChange={setValue}/><output data-testid="picked">{value?.token ?? 'none'}</output><output data-testid="snapshot">{value?.snapshot.chainedMaxRowId}</output></I18nProvider>
}
const trigger=():HTMLElement=>screen.getByRole('button',{name:/^Source session:/})
const optionTexts=():string[]=>screen.queryAllByRole('option').map(option=>option.textContent ?? '')

it('retains the selected Session on catalog failure and retries explicitly',async()=>{
  const sessions=vi.fn().mockRejectedValueOnce(new Error('catalog unavailable')).mockResolvedValue(page([session]))
  bridge(sessions)
  render(<Picker/>)
  expect((await screen.findByRole('alert')).textContent).toContain('catalog unavailable')
  expect(trigger().textContent).toContain('2026-11-09 15:42Z')
  fireEvent.click(screen.getByRole('button',{name:'Retry'}))
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByTestId('picked').textContent).toBe('selected')
})

it('refreshes the selected snapshot even outside the first page and discards an obsolete paging reply',async()=>{
  let notify=()=>{}
  let oldPage!:(value:SourceSessionPage)=>void
  const fresh={...snapshot,chainedMaxRowId:3,chainedCount:3,chainedTailId:'c'}
  const sessions=vi.fn().mockResolvedValueOnce(page([session],{hasMore:true,nextCursor:'next',total:2}))
    .mockImplementationOnce(()=>new Promise<SourceSessionPage>(resolve=>{oldPage=resolve}))
    .mockResolvedValueOnce(page([{...session,token:'other',sessionId:'other-session'}],{snapshot:fresh}))
  bridge(sessions,callback=>{notify=callback;return()=>{}})
  render(<Picker/>)
  fireEvent.click(trigger())
  fireEvent.click(await screen.findByRole('button',{name:'Load more sessions (1 / 2)'}))
  await act(async()=>notify())
  fireEvent.click(screen.getByRole('button',{name:'Refresh sessions'}))
  await waitFor(()=>expect(screen.getByTestId('snapshot').textContent).toBe('3'))
  await act(async()=>oldPage(page([{...session,token:'obsolete',sessionId:'obsolete-session'}])))
  expect(screen.getByTestId('snapshot').textContent).toBe('3')
  expect(optionTexts().join('|')).not.toContain('obsolete-session')
  expect(screen.getByRole('listbox').textContent).toContain('other-session')
})

it('names a Session by time, source and event count, with the raw ids second',async()=>{
  bridge(async()=>page([session,{...make(1),source:'codex',eventCount:1}]))
  render(<Picker initial={null}/>)
  fireEvent.click(trigger())
  await waitFor(()=>expect(optionTexts()).toHaveLength(3))
  const options=screen.getAllByRole('option')
  expect(options.map(option=>option.textContent)).toEqual([
    'All sessions',
    '2026-11-09 15:42Z · Claude Code · 38 eventssession · capture',
    '2026-11-09 15:41Z · Codex · 1 eventsconv-01 · apture-1'
  ])
  expect(within(options[1]).getByText('session · capture').className).toContain('font-mono')
})

it('finds one of 30 Sessions by typing and picks it with Enter, returning focus to the trigger',async()=>{
  const all=Array.from({length:30},(_,i)=>make(i))
  const sessions=vi.fn(async(req:SourceSessionRequest)=>page(all.filter(item=>!req.query||item.sessionId.includes(req.query))))
  bridge(sessions)
  render(<Picker initial={null}/>)
  fireEvent.click(trigger())
  const field=await screen.findByRole('combobox',{name:'Search by time, source or ID'})
  await waitFor(()=>expect(optionTexts()).toHaveLength(31))
  expect(document.activeElement).toBe(field)
  fireEvent.change(field,{target:{value:'conv-17'}})
  await waitFor(()=>expect(optionTexts()).toHaveLength(1))
  expect(sessions).toHaveBeenLastCalledWith({projectId:'p',kind:'agent',provider:undefined,query:'conv-17'})
  expect(field.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id)
  fireEvent.keyDown(field,{key:'Enter'})
  expect(screen.getByTestId('picked').textContent).toBe('t17')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.activeElement).toBe(trigger())
  // The next opening starts from the whole list again.
  fireEvent.click(trigger())
  await waitFor(()=>expect(optionTexts()).toHaveLength(31))
})

it('does not pick from a list that still answers an earlier search',async()=>{
  const all=Array.from({length:3},(_,i)=>make(i))
  const sessions=vi.fn(async(req:SourceSessionRequest)=>page(all.filter(item=>!req.query||item.sessionId.includes(req.query))))
  bridge(sessions)
  render(<Picker initial={null}/>)
  fireEvent.click(trigger())
  const field=await screen.findByRole('combobox')
  await waitFor(()=>expect(optionTexts()).toHaveLength(4))
  fireEvent.change(field,{target:{value:'conv-02'}})
  fireEvent.keyDown(field,{key:'ArrowDown'})
  fireEvent.keyDown(field,{key:'Enter'})
  expect(screen.getByTestId('picked').textContent).toBe('none')
  await waitFor(()=>expect(optionTexts()).toHaveLength(1))
  fireEvent.keyDown(field,{key:'Enter'})
  expect(screen.getByTestId('picked').textContent).toBe('t2')
})

it('moves with the arrow keys, picks All sessions, and Escape closes without changing',async()=>{
  const all=Array.from({length:3},(_,i)=>make(i))
  bridge(async()=>page(all))
  render(<Picker initial={all[1]}/>)
  fireEvent.keyDown(trigger(),{key:'ArrowDown'})
  const field=await screen.findByRole('combobox')
  await waitFor(()=>expect(optionTexts()).toHaveLength(4))
  // Opens on the current Session; the list is the catalogue with it first.
  expect(screen.getAllByRole('option').map(option=>option.getAttribute('aria-selected'))).toEqual(['false','false','true','false'])
  expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id)
  fireEvent.keyDown(field,{key:'ArrowDown'})
  expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[3].id)
  fireEvent.keyDown(field,{key:'ArrowDown'})
  expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[3].id)
  fireEvent.keyDown(field,{key:'Escape'})
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByTestId('picked').textContent).toBe('t1')
  expect(document.activeElement).toBe(trigger())
  fireEvent.click(trigger())
  const reopened=await screen.findByRole('combobox')
  fireEvent.keyDown(reopened,{key:'ArrowUp'})
  fireEvent.keyDown(reopened,{key:'ArrowUp'})
  fireEvent.keyDown(reopened,{key:'Enter'})
  expect(screen.getByTestId('picked').textContent).toBe('none')
  expect(trigger().textContent).toContain('All sessions')
})

it('says there are no conversations yet, and says no match differently',async()=>{
  const sessions=vi.fn(async(req:SourceSessionRequest)=>page(req.query?[]:[make(0)]))
  bridge(sessions)
  render(<Picker initial={null}/>)
  fireEvent.click(trigger())
  const field=await screen.findByRole('combobox')
  await waitFor(()=>expect(optionTexts()).toHaveLength(2))
  expect(screen.queryByText('No session matches')).toBeNull()
  fireEvent.change(field,{target:{value:'zzz'}})
  expect(await screen.findByText('No session matches')).toBeTruthy()
  expect(screen.queryByText('No AI conversations recorded yet')).toBeNull()
  expect(optionTexts()).toEqual([])
})

it.each([['agent','No AI conversations recorded yet'],['shell','No terminal sessions recorded yet']] as const)('shows the empty catalogue of %s sessions without a search box',async(kind,message)=>{
  bridge(async()=>page([]))
  render(<Picker kind={kind} initial={null}/>)
  fireEvent.click(trigger())
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByText('No session matches')).toBeNull()
  fireEvent.keyDown(trigger(),{key:'Escape'})
  expect(screen.queryByRole('listbox')).toBeNull()
})

it('bounds what a long paste asks for',async()=>{
  const sessions=vi.fn(async()=>page([make(0)]))
  bridge(sessions)
  render(<Picker initial={null}/>)
  fireEvent.click(trigger())
  const field=await screen.findByRole('combobox')
  fireEvent.change(field,{target:{value:`${'x'.repeat(100)} 2 3 4 5 6 7 8 9 10`}})
  await waitFor(()=>expect(sessions).toHaveBeenCalledTimes(2))
  expect(sessions.mock.calls[1][0].query).toBe(`${'x'.repeat(64)} 2 3 4 5 6 7 8`)
})
