import { contentState } from '../../../core/content-contract'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useEffect, useRef, useState } from 'react'
import type { CommandOutputState, ContentAnchor, ContentDescriptor, ContentFindCursor, ContentWindow, ContentUnavailable } from '../../../core/content-contract'
import { OUTPUT_NOTE_KEY } from '../lib/commandOutputNote'
import { safeDisplay, hasUnsafeText } from '../lib/evidenceText'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { toast } from './Toast'
import { isComposing } from '../lib/ime'

/** The field owns its byte position; switching sources cannot reuse a cursor. */
function ContentFieldReader({ descriptor, onReload, initialOffset = 0, initialFind, expanded = false, onMark, fragment, emptyKey = 'content.empty' }: { descriptor: ContentDescriptor; onReload: () => void; initialOffset?: number; initialFind?: string; expanded?: boolean; onMark: () => void; fragment?: ContentAnchor
  /** What zero saved bytes mean for this field, when the event says. */
  emptyKey?: string }): JSX.Element {
  const { t } = useI18n()
  const [window, setWindow] = useState<ContentWindow | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<ContentUnavailable | null>(null)
  const [changed, setChanged] = useState(false)
  const [needle, setNeedle] = useState(initialFind ?? '')
  const [findCursor, setFindCursor] = useState<ContentFindCursor | undefined>()
  const [notFound, setNotFound] = useState(false)
  const pre=useRef<HTMLPreElement>(null)
  const [selection,setSelection]=useState<{start:number;end:number}|null>(null)
  const [delivery,setDelivery]=useState<'copy'|'save'|null>(null)
  const [deliveryError,setDeliveryError]=useState<string|null>(null)
  const deliver=async(action:'copy'|'save'):Promise<void>=>{
    if(!descriptor.ref||delivery)return
    setDelivery(action);setDeliveryError(null)
    try{
      const reply=action==='copy' ? await globalThis.window.redlog.content.copySaved(descriptor.ref) : await globalThis.window.redlog.content.save(descriptor.ref)
      if(!alive.current)return
      if(!reply.ok){
        const key=reply.message==='clipboard-limit'?'content.clipboardLimit':reply.message==='destination-exists'?'content.destinationExists':reply.message==='project-destination'?'content.projectDestination':reply.status==='failed'?(action==='save'?'content.saveFailed':'common.copyFailed'):`content.status.${reply.status}`
        setDeliveryError(t(key));return
      }
      if(reply.value)toast(action==='copy'?t('common.copied'):t('content.savedTo',{path:'path' in reply.value?reply.value.path:''}),'success')
    }catch(error){if(alive.current)setDeliveryError(String(error))}
    finally{if(alive.current)setDelivery(null)}
  }
  const captureSelection=():void=>{
    // #549: when the stored text carries direction/zero-width controls the
    // <pre> does not show them verbatim, so a selection's character offsets no
    // longer map onto the stored bytes. Refuse to mark rather than write byte
    // offsets that would be wrong — copy and save still hand back the original.
    if (window && hasUnsafeText(window.text)) return
    const selected=globalThis.window.getSelection(),root=pre.current
    if(!selected||!root||!window||selected.isCollapsed||!selected.rangeCount){setSelection(null);return}
    const range=selected.getRangeAt(0)
    if(!root.contains(range.startContainer)||!root.contains(range.endContainer)){setSelection(null);return}
    const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset)
    const before=prefix.toString(),text=range.toString()
    if(window.text.slice(0,before.length)!==before||window.text.slice(before.length,before.length+text.length)!==text){setSelection(null);return}
    const start=window.offset+new TextEncoder().encode(before).length,end=start+new TextEncoder().encode(text).length
    setSelection(end>start?{start,end}:null)
  }
  const mark=async():Promise<void>=>{
    if(!selection||selection.end-selection.start>16384||!descriptor.ref)return
    const mine=generation.current
    setBusy(true);setError(null)
    try{
      const reply=await globalThis.window.redlog.content.anchor({ref:descriptor.ref,...selection})
      if(!alive.current||mine!==generation.current)return
      if(!reply.ok){setError(t(`content.status.${reply.status}`));return}
      onMark()
      globalThis.window.dispatchEvent(new CustomEvent('redlog:mark-content',{detail:reply.value}))
    }catch(e){if(alive.current&&mine===generation.current)setError(String(e))}finally{if(alive.current&&mine===generation.current)setBusy(false)}
  }
  const generation = useRef(0)
  const input = useRef(initialFind ?? '')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  const read = async (offset = 0, direction: 'next' | 'previous' | 'initial' = 'initial'): Promise<void> => {
    if (!descriptor.ref) return
    const seq = ++generation.current
    setBusy(true); setError(null); setUnavailable(null); setChanged(false)
    try {
      const reply = await globalThis.window.redlog.content.read({ ref: descriptor.ref,
        ...(direction === 'next' && window?.nextCursor ? { cursor: window.nextCursor } : { offset }) })
      if (!alive.current || seq !== generation.current) return
      if (!reply.ok) { setError(t(`content.status.${reply.status}`)); setUnavailable(reply.status); setChanged(reply.status === 'changed'); return }
      setHistory(prev => direction === 'next' && window ? [...prev, window.offset] : direction === 'previous' ? prev.slice(0, -1) : [])
      setWindow(reply.value)
      setSelection(null)
    } catch (e) { if (alive.current && seq === generation.current) { setError(String(e)); setUnavailable('failed') } }
    finally { if (alive.current && seq === generation.current) setBusy(false) }
  }
  /** `opening`: the first read is this search, so a miss still opens the start. */
  const find = async (opening = false): Promise<void> => {
    if (!descriptor.ref || !needle) return
    const seq = ++generation.current
    const query = needle
    let cursor = findCursor
    setBusy(true); setError(null); setUnavailable(null); setChanged(false); setNotFound(false)
    try {
      // A scan budget is a continuation, never a negative search result.
      while (alive.current && seq === generation.current) {
        const reply = await globalThis.window.redlog.content.find({ ref: descriptor.ref, needle: query, ...(cursor ? { cursor } : {}) })
        if (!alive.current || seq !== generation.current || query !== input.current) return
        if (!reply.ok) { setError(t(`content.status.${reply.status}`)); setUnavailable(reply.status); setChanged(reply.status === 'changed'); return }
        if (reply.value.match) {
          setFindCursor(reply.value.nextCursor ?? undefined)
          await read(reply.value.match.offset)
          return
        }
        if (!reply.value.hasMore || !reply.value.nextCursor) {
          setNotFound(true); setFindCursor(undefined)
          if (opening) await read(initialOffset)
          return
        }
        cursor = reply.value.nextCursor
      }
    } catch (e) { if (alive.current && seq === generation.current) { setError(String(e)); setUnavailable('failed') } }
    finally { if (alive.current && seq === generation.current) setBusy(false) }
  }
  // Opened at a hit (a loot row names the line it matched): the reader's own
  // Find takes it there and marks it, as if the operator had typed it.
  useEffect(() => { void (initialFind && descriptor.format !== 'binary' ? find(true) : read(initialOffset)) }, [descriptor.ref?.version, initialOffset])
  const matchAt = needle ? window?.text.indexOf(needle) ?? -1 : -1
  const raw=window?new TextEncoder().encode(window.text):null
  const fragmentStart=window&&fragment?Math.max(0,fragment.start-window.offset):0
  const fragmentEnd=window&&fragment?Math.min(raw?.length??0,fragment.end-window.offset):0
  const highlightAt=needle?matchAt:raw&&fragmentEnd>fragmentStart?new TextDecoder().decode(raw.subarray(0,fragmentStart)).length:-1
  const highlightLength=needle?needle.length:raw&&fragmentEnd>fragmentStart?new TextDecoder().decode(raw.subarray(fragmentStart,fragmentEnd)).length:0
  const state = contentState(unavailable ? { ...descriptor, status: unavailable } : descriptor)
  if (!descriptor.ref) return <p role="status" data-content-state={state} className="text-xs text-amber-300">{t(`content.status.${descriptor.status}`)}</p>
  return <div data-content-state={state} className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <input type="search" aria-label={t('content.find')} value={needle} disabled={descriptor.format === 'binary'}
        onChange={e => { input.current = e.target.value; setNeedle(e.target.value); setFindCursor(undefined); setNotFound(false); generation.current++; setBusy(false) }}
        onKeyDown={e => { if (e.key === 'Enter' && !busy && !isComposing(e)) void find() }}
        className="min-w-0 flex-1 rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-sm" />
      <Button disabled={busy || !needle || descriptor.format === 'binary'} onClick={() => void find()}>{t('content.find')}</Button>
      {busy && <Button onClick={() => { generation.current++; setBusy(false) }}>{t('content.cancel')}</Button>}
      {selection && <Button disabled={busy||selection.end-selection.start>16384} onClick={()=>void mark()}>{t('content.markSelection')}</Button>}
      {window && <CopyButton text={window.text} label={t(window.offset > 0 || window.hasMore ? 'content.copyWindow' : 'firstRun.copy')} />}
      {window && (window.offset>0||window.hasMore) && descriptor.format!=='binary' && <Button disabled={busy||delivery!==null} aria-busy={delivery==='copy'} onClick={()=>void deliver('copy')}>{t('content.copySaved')}</Button>}
      <Button disabled={busy||delivery!==null} aria-busy={delivery==='save'} onClick={()=>void deliver('save')}>{t(delivery==='save'?'marker.saving':'content.saveSaved')}</Button>
    </div>
    <p className="text-xs text-redlog-text-dim">{t('content.saveBoundary')}</p>
    {selection && selection.end-selection.start>16384 && <p role="status" className="text-xs text-amber-300">{t('content.selectionTooLarge')}</p>}
    {deliveryError && <p role="alert" className="text-xs text-amber-300">{deliveryError}</p>}
    {error && <div role="alert" className="text-xs text-amber-300 break-words">{error} <Button onClick={() => changed ? onReload() : void read(window?.offset ?? 0)}>{t('common.retry')}</Button></div>}
    {notFound && <p role="status" className="text-xs text-redlog-text-dim">{t('content.notFound')}</p>}
    {state === 'truncated' && <p role="status" className="text-xs text-amber-300">{t('content.partial')}</p>}
    {descriptor.format === 'binary' && <p className="text-xs text-redlog-text-dim">{t('content.binary')}</p>}
    {window && <>
      <pre ref={pre} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0} className={`${expanded ? 'max-h-[70vh]' : 'max-h-80'} overflow-auto whitespace-pre-wrap break-words bg-redlog-elevated p-3 text-xs font-mono`}>{highlightAt >= 0 ? <>{safeDisplay(window.text.slice(0, highlightAt))}<mark className="bg-redlog-accent/25 text-redlog-text">{safeDisplay(window.text.slice(highlightAt, highlightAt + highlightLength))}</mark>{safeDisplay(window.text.slice(highlightAt + highlightLength))}</> : safeDisplay(window.text) || (state === 'empty' ? t(emptyKey) : '')}</pre>
      <div className="flex flex-wrap items-center gap-2 text-xs text-redlog-text-dim">
        <span className="font-mono">{window.offset}–{window.end} / {window.total} B</span>
        <Button disabled={busy || window.offset === 0} onClick={() => void read(history.at(-1) ?? Math.max(0, window.offset - 65536), 'previous')}>{t('content.previous')}</Button>
        <Button disabled={busy || !window.hasMore} onClick={() => void read(0, 'next')}>{t('content.next')}</Button>
      </div>
    </>}
  </div>
}

/** Reader state held by a parent that wants to open it from elsewhere. */
export type ReaderMode = 'closed' | 'inline' | 'expanded'
export interface ReaderControl { mode: ReaderMode; setMode: (mode: ReaderMode) => void }

export function EventContentReader({ projectId, eventId, active = true, anchor, find, expanded: expandedProp, onExpandedChange, outputState }: { projectId: string; eventId: string; active?: boolean; anchor?: ContentAnchor
  /** Text to open each field at, through the reader's own Find. */
  find?: string
  expanded?: boolean; onExpandedChange?: (expanded: boolean) => void
  /** A shell command's output state: an empty stdout/stderr is only "no
   *  content" when the producer said so (report 10, A.4 #1). */
  outputState?: CommandOutputState }): JSX.Element {
  const { t } = useI18n()
  const outputEmptyKey = outputState && !['inline', 'saved', 'recorded'].includes(outputState) ? OUTPUT_NOTE_KEY[outputState] : undefined
  const fields = useReadState(async () => {
    const reply = await window.redlog.content.list({ projectId, eventId })
    if (!reply.ok) throw new Error(t(`content.status.${reply.status}`))
    return reply.value
  }, true, [projectId, eventId])
  const [selected, setSelected] = useState<string | null>(anchor?.ref.field ?? null)
  const [ownExpanded,setOwnExpanded]=useState(false)
  const expanded=expandedProp??ownExpanded
  const setExpanded=(next:boolean):void=>{if(onExpandedChange)onExpandedChange(next);else setOwnExpanded(next)}
  const root=useRef<HTMLDivElement>(null)
  useFocusTrap(root,expanded&&active)
  useEffect(()=>{if(!active)setExpanded(false)},[active])
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const visibleFields = fields.state.value?.filter(field => field.field !== 'stderr'
    || (contentState(field) !== 'empty' && field.status !== 'not-captured'))
  const current = visibleFields?.find(f => f.field === selected)
    ?? visibleFields?.find(f => f.status === 'available' && ['stdout', 'output', 'full', 'response_body', 'output_body'].includes(f.field))
    ?? visibleFields?.[0]
  useEffect(() => {
    if (current) setVisited(prev => prev.has(current.field) ? prev : new Set([...prev, current.field]))
  }, [current?.field])
  if(anchor && current?.field===anchor.ref.field && current.ref?.version!==anchor.ref.version)return <p role="alert">{t('content.status.changed')}</p>
  return <div ref={root} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} aria-label={expanded?t('content.savedContent'):undefined}
    onKeyDown={e=>{
      if(!expanded)return
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setExpanded(false)}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f'){
        e.preventDefault();e.stopPropagation()
        const field=[...root.current!.querySelectorAll<HTMLInputElement>('input[type="search"]')].find(input=>!input.disabled&&!input.closest('[hidden]'))
        field?.focus();field?.select()
      }
    }}
    className={expanded?'fixed inset-3 z-[60] rounded-xl border border-redlog-border bg-redlog-bg p-pad overflow-auto space-y-2 shadow-xl':'min-w-0 space-y-2'} aria-busy={fields.state.phase === 'loading'}>
    {fields.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {fields.state.phase === 'failed' && <div role="alert" className="text-amber-300 text-xs">{fields.state.error} <Button onClick={fields.retry}>{t('common.retry')}</Button></div>}
    {fields.state.phase === 'loaded' && !current && <p className="text-xs text-redlog-text-dim">{t('content.noText')}</p>}
    {current && <>
      <div className="flex flex-wrap gap-2 items-center"><Button size="compact" level="quiet" onClick={()=>setExpanded(!expanded)}>{t(expanded?'content.collapseReader':'content.expandReader')}</Button>
      <select aria-label={t('content.field')} value={current.field} onChange={e => setSelected(e.target.value)} className="max-w-full bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-sm">
        {visibleFields?.map(f => <option key={f.field} value={f.field}>{f.storage === 'terminal-cast' ? t('content.terminalOutput') : t(`content.field.${f.field}`)}</option>)}
      </select></div>
      {visibleFields?.filter(field => visited.has(field.field) || field.field === current.field).map(field =>
        <div key={`${projectId}:${eventId}:${field.field}:${field.ref?.version}`} hidden={field.field !== current.field}>
          <ContentFieldReader descriptor={field} onReload={fields.retry} expanded={expanded} fragment={anchor?.ref.field===field.field?anchor:undefined} initialOffset={anchor?.ref.field===field.field?anchor.start:0} initialFind={anchor?undefined:find} onMark={()=>setExpanded(false)}
            emptyKey={outputEmptyKey && (field.field === 'stdout' || field.field === 'stderr') ? outputEmptyKey : undefined} />
        </div>)}
    </>}
  </div>
}
