import { useEffect, useRef, useState } from 'react'
import type { ContentDescriptor, ContentFindCursor, ContentWindow } from '../../../core/content-contract'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { Button } from './Button'
import { CopyButton } from './CopyButton'

/** The field owns its byte position; switching sources cannot reuse a cursor. */
function ContentFieldReader({ descriptor, onReload }: { descriptor: ContentDescriptor; onReload: () => void }): JSX.Element {
  const { t } = useI18n()
  const [window, setWindow] = useState<ContentWindow | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const [needle, setNeedle] = useState('')
  const [findCursor, setFindCursor] = useState<ContentFindCursor | undefined>()
  const [notFound, setNotFound] = useState(false)
  const generation = useRef(0)
  const input = useRef('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  const read = async (offset = 0, direction: 'next' | 'previous' | 'initial' = 'initial'): Promise<void> => {
    if (!descriptor.ref) return
    const seq = ++generation.current
    setBusy(true); setError(null); setChanged(false)
    try {
      const reply = await globalThis.window.redlog.content.read({ ref: descriptor.ref,
        ...(direction === 'next' && window?.nextCursor ? { cursor: window.nextCursor } : { offset }) })
      if (!alive.current || seq !== generation.current) return
      if (!reply.ok) { setError(t(`content.status.${reply.status}`)); setChanged(reply.status === 'changed'); return }
      setHistory(prev => direction === 'next' && window ? [...prev, window.offset] : direction === 'previous' ? prev.slice(0, -1) : [])
      setWindow(reply.value)
    } catch (e) { if (alive.current && seq === generation.current) setError(String(e)) }
    finally { if (alive.current && seq === generation.current) setBusy(false) }
  }
  useEffect(() => { void read() }, [descriptor.ref?.version])
  const find = async (): Promise<void> => {
    if (!descriptor.ref || !needle) return
    const seq = ++generation.current
    const query = needle
    let cursor = findCursor
    setBusy(true); setError(null); setChanged(false); setNotFound(false)
    try {
      // A scan budget is a continuation, never a negative search result.
      while (alive.current && seq === generation.current) {
        const reply = await globalThis.window.redlog.content.find({ ref: descriptor.ref, needle: query, ...(cursor ? { cursor } : {}) })
        if (!alive.current || seq !== generation.current || query !== input.current) return
        if (!reply.ok) { setError(t(`content.status.${reply.status}`)); setChanged(reply.status === 'changed'); return }
        if (reply.value.match) {
          setFindCursor(reply.value.nextCursor ?? undefined)
          await read(reply.value.match.offset)
          return
        }
        if (!reply.value.hasMore || !reply.value.nextCursor) { setNotFound(true); setFindCursor(undefined); return }
        cursor = reply.value.nextCursor
      }
    } catch (e) { if (alive.current && seq === generation.current) setError(String(e)) }
    finally { if (alive.current && seq === generation.current) setBusy(false) }
  }
  const matchAt = needle ? window?.text.indexOf(needle) ?? -1 : -1
  if (!descriptor.ref) return <p role="status" className="text-xs text-amber-300">{t(`content.status.${descriptor.status}`)}</p>
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <input type="search" aria-label={t('content.find')} value={needle} disabled={descriptor.format === 'binary'}
        onChange={e => { input.current = e.target.value; setNeedle(e.target.value); setFindCursor(undefined); setNotFound(false); generation.current++; setBusy(false) }}
        onKeyDown={e => { if (e.key === 'Enter' && !busy) void find() }}
        className="min-w-0 flex-1 rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-sm" />
      <Button disabled={busy || !needle || descriptor.format === 'binary'} onClick={() => void find()}>{t('content.find')}</Button>
      {busy && <Button onClick={() => { generation.current++; setBusy(false) }}>{t('content.cancel')}</Button>}
      {window && <CopyButton text={window.text} label={t(window.offset > 0 || window.hasMore ? 'content.copyWindow' : 'firstRun.copy')} />}
    </div>
    {error && <div role="alert" className="text-xs text-amber-300 break-words">{error} <Button onClick={() => changed ? onReload() : void read(window?.offset ?? 0)}>{t('common.retry')}</Button></div>}
    {notFound && <p role="status" className="text-xs text-redlog-text-dim">{t('content.notFound')}</p>}
    {descriptor.capture === 'partial' && <p role="status" className="text-xs text-amber-300">{t('content.partial')}</p>}
    {descriptor.format === 'binary' && <p className="text-xs text-redlog-text-dim">{t('content.binary')}</p>}
    {window && <>
      <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-redlog-elevated p-3 text-xs font-mono">{matchAt >= 0 ? <>{window.text.slice(0, matchAt)}<mark className="bg-redlog-accent/25 text-redlog-text">{window.text.slice(matchAt, matchAt + needle.length)}</mark>{window.text.slice(matchAt + needle.length)}</> : window.text || t('content.empty')}</pre>
      <div className="flex flex-wrap items-center gap-2 text-xs text-redlog-text-dim">
        <span className="font-mono">{window.offset}–{window.end} / {window.total} B</span>
        <Button disabled={busy || window.offset === 0} onClick={() => void read(history.at(-1) ?? Math.max(0, window.offset - 65536), 'previous')}>{t('content.previous')}</Button>
        <Button disabled={busy || !window.hasMore} onClick={() => void read(0, 'next')}>{t('content.next')}</Button>
      </div>
    </>}
  </div>
}

export function EventContentReader({ projectId, eventId }: { projectId: string; eventId: string }): JSX.Element {
  const { t } = useI18n()
  const fields = useReadState(async () => {
    const reply = await window.redlog.content.list({ projectId, eventId })
    if (!reply.ok) throw new Error(t(`content.status.${reply.status}`))
    return reply.value
  }, true, [projectId, eventId])
  const [selected, setSelected] = useState<string | null>(null)
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const current = fields.state.value?.find(f => f.field === selected)
    ?? fields.state.value?.find(f => f.status === 'available' && ['stdout', 'output', 'full', 'response_body', 'output_body'].includes(f.field))
    ?? fields.state.value?.[0]
  useEffect(() => {
    if (current) setVisited(prev => prev.has(current.field) ? prev : new Set([...prev, current.field]))
  }, [current?.field])
  return <div className="min-w-0 space-y-2" aria-busy={fields.state.phase === 'loading'}>
    {fields.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {fields.state.phase === 'failed' && <div role="alert" className="text-amber-300 text-xs">{fields.state.error} <Button onClick={fields.retry}>{t('common.retry')}</Button></div>}
    {fields.state.phase === 'loaded' && !current && <p className="text-xs text-redlog-text-dim">{t('content.noText')}</p>}
    {current && <>
      <select aria-label={t('content.field')} value={current.field} onChange={e => setSelected(e.target.value)} className="max-w-full bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-sm">
        {fields.state.value?.map(f => <option key={f.field} value={f.field}>{t(`content.field.${f.field}`)}</option>)}
      </select>
      {fields.state.value?.filter(field => visited.has(field.field) || field.field === current.field).map(field =>
        <div key={`${projectId}:${eventId}:${field.field}:${field.ref?.version}`} hidden={field.field !== current.field}>
          <ContentFieldReader descriptor={field} onReload={fields.retry} />
        </div>)}
    </>}
  </div>
}
