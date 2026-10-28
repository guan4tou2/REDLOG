import { useState } from 'react'
import type { ContentAnchor } from '../../../core/content-contract'
import { useReadState } from '../lib/readState'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { EventContentReader } from './EventContentReader'

export function ContentAnchorView({anchor}:{anchor:ContentAnchor}): JSX.Element {
  const {t}=useI18n(),[open,setOpen]=useState(false)
  const check=useReadState(async()=>{
    const reply=await window.redlog.content.resolveAnchor(anchor)
    if(!reply.ok)throw new Error(t(`content.status.${reply.status}`))
    return reply.value
  },open,[anchor])
  return <div className="min-w-0 space-y-2">
    <Button size="compact" level="quiet" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{t('content.openFragment')}</Button>
    {open && <>
      {check.state.phase==='loading' && <span role="status">{t('search.loading')}</span>}
      {check.state.phase==='failed' && <p role="alert" className="text-xs text-amber-300">{check.state.error} <Button onClick={check.retry}>{t('common.retry')}</Button></p>}
      {check.state.phase==='loaded' && <><span className="font-mono text-xs text-redlog-text-dim">{anchor.start}–{anchor.end} B</span><EventContentReader projectId={anchor.ref.projectId} eventId={anchor.ref.eventId} anchor={anchor} /></>}
    </>}
  </div>
}
