import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { SourceSession, SourceSessionPage } from '../../../core/source-sessions'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { Button } from './Button'
import { formatDateTime } from '../lib/time'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Keeps the request inside what the main process accepts, so a long paste is
 *  shortened here instead of failing the whole catalogue read. */
function boundedQuery(text: string): string {
  return text.split(/\s+/).filter(Boolean).slice(0, 8).map(term => term.slice(0, 64)).join(' ')
}

const SOURCE_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/** Time, source and a stored-event count — what a person recognises a
 *  conversation by. The raw ids are the second line of an option, not this. */
function sessionLabel(item: SourceSession, t: Translate): string {
  return `${formatDateTime(item.lastAt)} · ${SOURCE_NAMES[item.source] ?? item.source} · ${t('targets.events', { count: item.eventCount })}`
}

export default function SourceSessionPicker({kind,provider,value,onChange}: {
  kind:'agent'|'shell';provider?:string;value:SourceSession|null;onChange:(session:SourceSession|null)=>void
}): JSX.Element {
  const {t}=useI18n()
  const ids=useId()
  const [open,setOpen]=useState(false)
  const [search,setSearch]=useState('')
  const [applied,setApplied]=useState('')
  // The highlighted option is remembered by token, not position: pages arrive under it.
  const [activeKey,setActiveKey]=useState('')
  const root=useRef<HTMLDivElement>(null)
  const trigger=useRef<HTMLButtonElement>(null)
  const field=useRef<HTMLInputElement>(null)
  const loaded=useReadState(async()=>{
    const config=await window.redlog.config.get() as {engagement:{id:string}}
    const request={projectId:config.engagement.id,kind,provider,...(applied?{query:applied}:{})}
    return {request,page:await window.redlog.events.sourceSessions(request)}
  },true,[kind,provider,applied])
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const [newEvents,setNewEvents]=useState(false)
  const refreshSelection=useRef(false)
  useEffect(()=>window.redlog.events.onNewBatch(()=>setNewEvents(true)),[])
  const refresh=():void=>{generation.current++;setBusy(false);refreshSelection.current=true;setNewEvents(false);setError(null);loaded.retry()}
  const generation=useRef(0)
  useEffect(()=>{generation.current++;setBusy(false);setError(null);return ()=>{generation.current++}},[kind,provider,applied])
  const more=async():Promise<void>=>{
    const current=loaded.state.value
    if(loaded.state.phase!=='loaded'||!current?.page.nextCursor||busy)return
    const mine=generation.current
    setBusy(true);setError(null)
    try {
      const page:SourceSessionPage=await window.redlog.events.sourceSessions({...current.request,cursor:current.page.nextCursor})
      if(mine===generation.current)loaded.update(()=>({request:current.request,page:{...page,items:[...current.page.items,...page.items]}}))
    }catch(e){if(mine===generation.current)setError(String(e))}
    finally{if(mine===generation.current)setBusy(false)}
  }
  const page=loaded.state.value?.page
  const items=page?.items ?? []
  useEffect(()=>{
    if(refreshSelection.current&&loaded.state.phase==='loaded'){
      refreshSelection.current=false
      if(value&&page)onChange(items.find(item=>item.token===value.token) ?? {...value,snapshot:page.snapshot})
    }
  },[loaded.state])

  // The typed text reaches the main process after a short pause: each read
  // walks the whole project's stored events, so a keystroke is not a request.
  useEffect(()=>{
    const next=boundedQuery(search)
    if(next===applied)return
    const timer=setTimeout(()=>setApplied(next),200)
    return ()=>clearTimeout(timer)
  },[search,applied])
  useEffect(()=>{setActiveKey('')},[applied])
  useEffect(()=>{if(open)field.current?.focus()},[open])

  const searching=applied!==''
  const entries:Array<SourceSession|null>=[
    ...(searching?[]:[null]),
    ...(value&&!searching&&!items.some(item=>item.token===value.token)?[value]:[]),
    ...items
  ]
  const active=Math.max(0,entries.findIndex(entry=>(entry?.token ?? '')===activeKey))
  const answered=loaded.state.phase==='loaded'&&loaded.state.value.request.query===(applied||undefined)
  const settled=answered&&boundedQuery(search)===applied
  const catalogEmpty=Boolean(loaded.state.value&&!loaded.state.value.request.query&&loaded.state.value.page.total===0)
  const close=(returnFocus:boolean):void=>{
    setOpen(false);setSearch('');setApplied('')
    if(returnFocus)trigger.current?.focus()
  }
  const choose=(session:SourceSession|null):void=>{onChange(session);close(true)}
  const openList=():void=>{
    setActiveKey(value?.token ?? '')
    setOpen(true)
  }
  const move=(to:number):void=>setActiveKey(entries[Math.max(0,Math.min(entries.length-1,to))]?.token ?? '')
  const onKeyDown=(e:React.KeyboardEvent):void=>{
    if(e.nativeEvent.isComposing||e.keyCode===229)return
    if(e.key==='ArrowDown'){e.preventDefault();move(active+1)}
    else if(e.key==='ArrowUp'){e.preventDefault();move(active-1)}
    else if(e.key==='Home'&&e.target===field.current&&search===''){e.preventDefault();move(0)}
    else if(e.key==='End'&&e.target===field.current&&search===''){e.preventDefault();move(entries.length-1)}
    else if(e.key==='Enter'&&e.target===field.current){
      e.preventDefault()
      // A list that still answers an earlier search is not what the person is looking at.
      if(!settled){setApplied(boundedQuery(search));return}
      if(entries.length>0)choose(entries[active])
    }
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true)}
  }
  const optionId=(index:number):string=>`${ids}-option-${index}`
  const label=value?sessionLabel(value,t):t('workspace.allSessions')
  const listId=`${ids}-list`
  return <div className="flex flex-wrap items-center gap-2 min-w-0" aria-busy={loaded.state.phase==='loading'||busy}>
    <div ref={root} className="relative min-w-0 max-w-full"
      onBlur={e=>{if(open&&!root.current?.contains(e.relatedTarget as Node|null))close(false)}}
      onKeyDown={open?onKeyDown:undefined}>
      <button ref={trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined}
        aria-label={`${t('workspace.session')}: ${label}`}
        onClick={()=>open?close(true):openList()}
        onKeyDown={e=>{if(!open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();openList()}}}
        className="inline-flex max-w-full min-w-0 items-center gap-2 rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs hover:bg-redlog-elevated-hover">
        <span className="truncate">{label}</span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-redlog-text-dim" />
      </button>
      {open && <div onMouseDown={e=>{if(e.target!==field.current)e.preventDefault()}}
        className="absolute left-0 top-full z-30 mt-1 w-[28rem] max-w-[90vw] rounded-lg border border-redlog-border bg-redlog-surface shadow-lg">
        {!catalogEmpty && <input ref={field} type="search" role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={entries.length>0?optionId(active):undefined}
          aria-label={t('workspace.sessionSearch')} placeholder={t('workspace.sessionSearch')} maxLength={200}
          value={search} onChange={e=>setSearch(e.target.value)}
          className="h-8 w-full rounded-t-lg border-b border-redlog-border bg-transparent px-3 text-xs focus:outline-none" />}
        <ul id={listId} role="listbox" aria-label={t('workspace.session')} aria-busy={!settled} className="max-h-72 overflow-y-auto py-1">
          {entries.map((entry,index)=><li key={entry?.token ?? 'all'} id={optionId(index)} role="option"
            aria-selected={(entry?.token ?? '')===(value?.token ?? '')}
            onMouseMove={()=>setActiveKey(entry?.token ?? '')}
            onClick={()=>choose(entry)}
            className={`cursor-pointer px-3 py-1.5 text-xs ${index===active?'bg-redlog-elevated-hover':''} ${(entry?.token ?? '')===(value?.token ?? '')?'text-redlog-text':'text-redlog-text-dim'}`}>
            {entry
              ? <><div className="truncate">{sessionLabel(entry,t)}</div>
                <div className="truncate font-mono text-[11px] text-redlog-text-faint">{entry.sessionId} · {entry.captureSessionId.slice(-8)}</div></>
              : t('workspace.allSessions')}
          </li>)}
        </ul>
        {answered && items.length===0 && <p role="status" className="px-3 py-2 text-xs text-redlog-text-dim">{t(searching?'workspace.noSessionMatch':kind==='agent'?'workspace.noSessions.agent':'workspace.noSessions.shell')}</p>}
        {page?.hasMore && <div className="border-t border-redlog-border p-1">
          <Button size="compact" level="quiet" disabled={busy||loaded.state.phase!=='loaded'} onClick={()=>void more()}>{t('workspace.moreSessions',{loaded:items.length,total:page.total})}</Button>
        </div>}
      </div>}
    </div>
    {newEvents && <Button size="compact" level="quiet" onClick={refresh}>{t('workspace.refreshSessions')}</Button>}
    {(error||loaded.state.phase==='failed') && <span role="alert" className="text-xs text-amber-300">{error ?? (loaded.state.phase==='failed'?loaded.state.error:'')} <Button size="compact" level="quiet" onClick={refresh}>{t('common.retry')}</Button></span>}
  </div>
}
