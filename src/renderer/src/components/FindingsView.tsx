import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'
import { EmptyState } from './Feedback'
import { emptyStateFor } from '../lib/emptyState'
import { confirm } from './ConfirmDialog'
import { toast } from './Toast'

const TAG_COLORS = [
  { bg: 'bg-red-500/20', text: 'text-red-400', dot: 'bg-red-400' },
  { bg: 'bg-blue-500/20', text: 'text-blue-400', dot: 'bg-blue-400' },
  { bg: 'bg-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  { bg: 'bg-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-400' },
  { bg: 'bg-purple-500/20', text: 'text-purple-400', dot: 'bg-purple-400' },
  { bg: 'bg-pink-500/20', text: 'text-pink-400', dot: 'bg-pink-400' },
  { bg: 'bg-cyan-500/20', text: 'text-cyan-400', dot: 'bg-cyan-400' },
  { bg: 'bg-orange-500/20', text: 'text-orange-400', dot: 'bg-orange-400' }
]

function getTagColor(title: string): typeof TAG_COLORS[0] {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

export function QuickMarksView({ onOpenInTimeline, onEmptyAction }: {
  onOpenInTimeline?: (ts: number) => void
  onEmptyAction?: (target: string) => void
} = {}): JSX.Element {
  const [marks, setMarks] = useState<QuickMark[]>([])
  const [selected, setSelected] = useState<QuickMark | null>(null)
  const [creating, setCreating] = useState(false)
  const [browserTab, setBrowserTab] = useState<BrowserTabInfo | null>(null)
  const [search, setSearch] = useState('')
  // Pinned mark ids — persisted to localStorage. Chain-immutable events can't
  // be reordered in the DB, so pin state is a UI overlay: pinned float to the
  // top of the list, keeping their timestamp intact.
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('redlog-marks-pinned') || '[]')) } catch { return new Set() }
  })
  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      localStorage.setItem('redlog-marks-pinned', JSON.stringify([...next]))
      return next
    })
  }, [])
  const { t } = useI18n()

  const filteredMarks = (() => {
    const list = search.trim()
      ? marks.filter((m) => {
          const q = search.toLowerCase()
          return m.title.toLowerCase().includes(q)
            || (m.url ?? '').toLowerCase().includes(q)
            || (m.note ?? '').toLowerCase().includes(q)
        })
      : marks
    return [...list].sort((a, b) => {
      const ap = pinned.has(a.id) ? 1 : 0
      const bp = pinned.has(b.id) ? 1 : 0
      if (ap !== bp) return bp - ap
      return b.createdAt - a.createdAt
    })
  })()

  const refresh = useCallback(() => {
    window.redlog.quickmarks.list().then(setMarks)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    // Poll CDP for the currently-focused tab. 3s while connected is fine, but
    // if the CDP browser isn't running there's no point polling every 3s —
    // back off to 10s until it reconnects (audit finding P1 #25).
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      const tab = await window.redlog.cdp.getTab().catch(() => ({ connected: false } as never))
      if (stopped) return
      setBrowserTab(tab)
      timer = setTimeout(tick, tab.connected ? 3000 : 10000)
    }
    tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [])

  const quickCapture = async (): Promise<void> => {
    const tab = await window.redlog.cdp.getTab()
    setBrowserTab(tab)
    setCreating(true)
    setSelected(null)
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-redlog-border flex flex-col">
        <div className="p-2 border-b border-redlog-border">
          <div className="flex items-center justify-between mb-2 gap-1">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex-1 truncate">
              {t('marks.title', { count: marks.length })}
            </span>
            {marks.length > 0 && (
              <button
                onClick={async () => {
                  const p = await (window.redlog.data as { exportMarks?: () => Promise<string | null> }).exportMarks?.()
                  if (p) toast(t('toast.exportedTo', { path: p }), 'success')
                  else toast(t('toast.exportFailed'), 'error')
                }}
                className="px-2 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
                title={t('marks.exportHint')}
              >
                {t('marks.export')}
              </button>
            )}
            <button
              onClick={quickCapture}
              className="px-2 py-1 text-xs bg-redlog-accent/20 text-redlog-accent rounded hover:bg-redlog-accent/30 font-semibold"
            >
              {t('marks.capture')}
            </button>
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            browserTab?.connected ? 'bg-green-500/10 text-green-400' : 'bg-zinc-800 text-zinc-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${browserTab?.connected ? 'bg-green-400' : 'bg-zinc-600'}`} />
            {browserTab?.connected
              ? <span className="truncate">{browserTab.url || t('marks.connected')}</span>
              : <span>{t('marks.cdpDisconnected')}</span>
            }
          </div>
        </div>
        {/* Search bar — hidden until 5+ marks (audit #22). Filters title / URL /
            note case-insensitively; live as the user types. */}
        {marks.length >= 5 && (
          <div className="px-2 py-1.5 border-b border-redlog-border">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('marks.searchPlaceholder')}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 font-mono focus:outline-none focus:border-red-500/40 placeholder-zinc-700"
            />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {filteredMarks.map((m) => {
            const tagColor = getTagColor(m.title)
            const isPinned = pinned.has(m.id)
            return (
              <button
                key={m.id}
                onClick={() => { setSelected(m); setCreating(false) }}
                className={`w-full text-left px-3 py-2.5 border-b border-redlog-border hover:bg-zinc-800/50 ${
                  selected?.id === m.id ? 'bg-zinc-800' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${tagColor.dot}`} />
                  <span className="text-xs text-zinc-200 truncate flex-1">{m.title}</span>
                  {/* Pinned marks get a small star indicator; pin/unpin action
                      lives in the detail panel (low-frequency action, keep
                      the list clean). */}
                  {isPinned && <span className="text-xs text-amber-400 shrink-0" aria-hidden="true">★</span>}
                </div>
                {m.url && <div className="text-xs text-blue-400/70 truncate mt-0.5 font-mono pl-4">{m.url}</div>}
                <div className="text-xs text-zinc-600 mt-0.5 pl-4">
                  {new Date(m.createdAt).toLocaleString()}
                </div>
              </button>
            )
          })}
          {filteredMarks.length === 0 && !creating && (
            marks.length === 0 ? (() => {
              // True-empty (no marks at all) gets the shared EmptyState + CTA;
              // the search-filtered-empty case keeps its plain "no matches" line.
              const es = emptyStateFor('marks', { captureDark: false })
              return (
                <EmptyState
                  icon="◈"
                  title={t(es.titleKey)}
                  subtitle={t(es.subtitleKey)}
                  action={es.action && es.action.target !== 'doc'
                    ? { label: t(es.action.labelKey), onClick: () => onEmptyAction?.(es.action!.target) }
                    : undefined}
                />
              )
            })() : (
              <div className="p-4 text-xs text-zinc-600 text-center">
                {t('marks.noSearchMatches', { query: search })}
              </div>
            )
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {creating && (
          <QuickMarkForm
            browserTab={browserTab}
            onSave={() => { setCreating(false); refresh() }}
            onCancel={() => setCreating(false)}
          />
        )}
        {selected && !creating && (
          <QuickMarkDetail
            mark={selected}
            onUpdate={() => { refresh(); window.redlog.quickmarks.get(selected.id).then((m) => m && setSelected(m)) }}
            onDelete={() => { setSelected(null); refresh() }}
            onOpenInTimeline={onOpenInTimeline}
            isPinned={pinned.has(selected.id)}
            onTogglePin={() => togglePin(selected.id)}
          />
        )}
        {!selected && !creating && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600 text-sm gap-2">
            <span>{t('marks.placeholder')}</span>
            <span className="text-xs text-zinc-700">{t('marks.placeholderSub')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function QuickMarkForm({ browserTab, onSave, onCancel, initial }: {
  browserTab: BrowserTabInfo | null
  onSave: () => void
  onCancel: () => void
  initial?: QuickMark
}): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? browserTab?.title ?? '')
  const [url, setUrl] = useState(initial?.url ?? browserTab?.url ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const { t } = useI18n()

  const submit = async (): Promise<void> => {
    if (initial) {
      await window.redlog.quickmarks.update(initial.id, { title, url, note })
    } else {
      await window.redlog.quickmarks.create({ title: title || 'Untitled', url: url || undefined, note })
    }
    onSave()
  }

  return (
    <div className="space-y-3 max-w-xl">
      <h3 className="text-sm font-semibold text-zinc-300">{initial ? t('marks.editMark') : t('marks.quickCapture')}</h3>

      {!initial && browserTab?.connected && (
        <div className="bg-green-500/10 border border-green-500/20 rounded px-3 py-2 text-xs text-green-400">
          {t('marks.autoCaptured', { title: browserTab.title || '' })}
        </div>
      )}
      {!initial && !browserTab?.connected && (
        <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-500">
          {t('marks.cdpHint')}
        </div>
      )}

      <div>
        <label className="text-xs text-zinc-500 uppercase tracking-wider">{t('marks.fieldTitle')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={t('marks.fieldTitlePlaceholder')}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 focus:border-red-500 outline-none" />
      </div>

      <div>
        <label className="text-xs text-zinc-500 uppercase tracking-wider">{t('marks.fieldUrl')}</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 focus:border-red-500 outline-none font-mono text-xs" />
      </div>

      <div>
        <label className="text-xs text-zinc-500 uppercase tracking-wider">{t('marks.fieldNote')}</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4}
          placeholder={t('marks.fieldNotePlaceholder')}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 outline-none resize-y" />
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={submit} className="px-4 py-1.5 bg-redlog-accent text-white text-xs rounded hover:bg-red-700">
          {initial ? t('marks.update') : t('marks.save')}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-zinc-800 text-zinc-400 text-xs rounded hover:bg-zinc-700">
          {t('marks.cancel')}
        </button>
      </div>
    </div>
  )
}

function QuickMarkDetail({ mark, onUpdate, onDelete, onOpenInTimeline, isPinned, onTogglePin }: {
  mark: QuickMark
  onUpdate: () => void
  onDelete: () => void
  onOpenInTimeline?: (ts: number) => void
  isPinned?: boolean
  onTogglePin?: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const { t } = useI18n()

  if (editing) {
    return <QuickMarkForm browserTab={null} initial={mark} onSave={() => { setEditing(false); onUpdate() }} onCancel={() => setEditing(false)} />
  }

  const handleDelete = async (): Promise<void> => {
    const ok = await confirm(t('confirm.deleteMark'), t('confirm.deleteMarkDesc'), true)
    if (!ok) return
    await window.redlog.quickmarks.delete(mark.id)
    onDelete()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-200">{mark.title}</h3>
          {mark.url && (
            <button
              onClick={(e) => { e.stopPropagation(); (window.redlog.app as { openExternal?: (u: string) => Promise<unknown> }).openExternal?.(mark.url as string) }}
              className="text-xs text-blue-400 font-mono mt-1 break-all text-left hover:text-blue-300 hover:underline transition-colors cursor-pointer"
              title={t('marks.openUrl')}
            >
              {mark.url} ↗
            </button>
          )}
          <div className="text-xs text-zinc-500 mt-1">
            {new Date(mark.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-1">
          {onOpenInTimeline && (
            <button onClick={() => onOpenInTimeline(mark.createdAt)} className="px-2 py-1 text-xs bg-zinc-800 text-cyan-400 rounded hover:bg-zinc-700">{t('loot.openInTimeline')}</button>
          )}
          <button onClick={() => setEditing(true)} className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700">{t('marks.edit')}</button>
          <button onClick={handleDelete} className="px-2 py-1 text-xs bg-zinc-800 text-red-400 rounded hover:bg-zinc-700">{t('marks.delete')}</button>
        </div>
      </div>

      {/* Pin toggle lives here (low-frequency action, out of the mark list). */}
      {onTogglePin && (
        <button
          onClick={onTogglePin}
          className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 ${
            isPinned ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'bg-zinc-800 text-zinc-500 hover:text-amber-400 hover:bg-zinc-700'
          }`}
          aria-pressed={!!isPinned}
        >
          <span>{isPinned ? '★' : '☆'}</span>
          <span>{isPinned ? t('marks.unpin') : t('marks.pin')}</span>
        </button>
      )}

      {mark.note && (
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider">{t('marks.fieldNote')}</label>
          <div className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900 rounded p-3 border border-zinc-800">{mark.note}</div>
        </div>
      )}

      {Object.keys(mark.context).length > 0 && (
        <div>
          <label className="text-xs text-zinc-500 uppercase tracking-wider">{t('marks.autoContext')}</label>
          <div className="mt-1 bg-zinc-900 rounded p-3 border border-zinc-800 space-y-1">
            {mark.context.browserUrl && (
              <div className="text-xs">
                <span className="text-zinc-500">{t('marks.browserUrl')}</span>{' '}
                <button
                  onClick={(e) => { e.stopPropagation(); (window.redlog.app as { openExternal?: (u: string) => Promise<unknown> }).openExternal?.(mark.context!.browserUrl as string) }}
                  className="text-blue-400 font-mono hover:text-blue-300 hover:underline transition-colors cursor-pointer"
                  title={t('marks.openUrl')}
                >
                  {mark.context.browserUrl} ↗
                </button>
              </div>
            )}
            {mark.context.browserTitle && (
              <div className="text-xs">
                <span className="text-zinc-500">{t('marks.pageTitle')}</span>{' '}
                <span className="text-zinc-300">{mark.context.browserTitle}</span>
              </div>
            )}
            {mark.context.externalIP && (
              <div className="text-xs">
                <span className="text-zinc-500">{t('marks.ipLabel')}</span>{' '}
                <span className="text-zinc-300 font-mono">{mark.context.externalIP}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
