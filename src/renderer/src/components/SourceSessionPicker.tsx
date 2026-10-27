import { useRef, useEffect, useState } from 'react'
import type { SourceSession, SourceSessionPage } from '../../../core/source-sessions'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { Button } from './Button'
import { formatDateTime } from '../lib/time'

export default function SourceSessionPicker({kind,provider,value,onChange}: {
  kind:'agent'|'shell';provider?:string;value:SourceSession|null;onChange:(session:SourceSession|null)=>void
}): JSX.Element {
  const {t}=useI18n()
  const loaded=useReadState(async()=>{
    const config=await window.redlog.config.get() as {engagement:{id:string}}
    const request={projectId:config.engagement.id,kind,provider}
    return {request,page:await window.redlog.events.sourceSessions(request)}
  },true,[kind,provider])
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const [newEvents,setNewEvents]=useState(false)
  const refreshSelection=useRef(false)
  useEffect(()=>window.redlog.events.onNewBatch(()=>setNewEvents(true)),[])
  const refresh=():void=>{generation.current++;setBusy(false);refreshSelection.current=true;setNewEvents(false);setError(null);loaded.retry()}
  const generation=useRef(0)
  useEffect(()=>{generation.current++;setBusy(false);setError(null);return ()=>{generation.current++}},[kind,provider])
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
  const options=value && !items.some(item=>item.token===value.token) ? [value,...items] : items
  return <div className="flex flex-wrap items-center gap-2 min-w-0" aria-busy={loaded.state.phase==='loading'||busy}>
    <select aria-label={t('workspace.session')} value={value?.token ?? ''} disabled={loaded.state.phase==='loading'}
      onChange={e=>onChange(options.find(item=>item.token===e.target.value) ?? null)}
      className="max-w-full min-w-0 rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs">
      <option value="">{t('workspace.allSessions')}</option>
      {options.map(item=><option key={item.token} value={item.token}>{formatDateTime(item.lastAt)} · {item.source} · {item.sessionId} · {item.captureSessionId.slice(-8)}</option>)}
    </select>
    {newEvents && <Button size="compact" level="quiet" onClick={refresh}>{t('workspace.refreshSessions')}</Button>}
    {page?.hasMore && <Button size="compact" level="quiet" disabled={busy||loaded.state.phase!=='loaded'} onClick={()=>void more()}>{t('workspace.moreSessions',{loaded:items.length,total:page.total})}</Button>}
    {(error||loaded.state.phase==='failed') && <span role="alert" className="text-xs text-amber-300">{error ?? (loaded.state.phase==='failed'?loaded.state.error:'')} <Button size="compact" level="quiet" onClick={refresh}>{t('common.retry')}</Button></span>}
  </div>
}
