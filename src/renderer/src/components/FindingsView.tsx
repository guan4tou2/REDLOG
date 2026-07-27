import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'

export function QuickMarksView(): JSX.Element {
  const [marks, setMarks] = useState<QuickMark[]>([])
  const [selected, setSelected] = useState<QuickMark | null>(null)
  const [creating, setCreating] = useState(false)
  const [browserTab, setBrowserTab] = useState<BrowserTabInfo | null>(null)
  const { t } = useI18n()

  const refresh = useCallback(() => {
    window.redlog.quickmarks.list().then(setMarks)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    window.redlog.cdp.getTab().then(setBrowserTab)
    const interval = setInterval(() => {
      window.redlog.cdp.getTab().then(setBrowserTab)
    }, 3000)
    return () => clearInterval(interval)
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
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              {t('marks.title', { count: marks.length })}
            </span>
            <button
              onClick={quickCapture}
              className="px-2 py-1 text-[10px] bg-redlog-accent/20 text-redlog-accent rounded hover:bg-redlog-accent/30 font-semibold"
            >
              {t('marks.capture')}
            </button>
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${
            browserTab?.connected ? 'bg-green-500/10 text-green-400' : 'bg-zinc-800 text-zinc-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${browserTab?.connected ? 'bg-green-400' : 'bg-zinc-600'}`} />
            {browserTab?.connected
              ? <span className="truncate">{browserTab.url || t('marks.connected')}</span>
              : <span>{t('marks.cdpDisconnected')}</span>
            }
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {marks.map((m) => (
            <button
              key={m.id}
              onClick={() => { setSelected(m); setCreating(false) }}
              className={`w-full text-left px-3 py-2.5 border-b border-redlog-border hover:bg-zinc-800/50 ${
                selected?.id === m.id ? 'bg-zinc-800' : ''
              }`}
            >
              <div className="text-xs text-zinc-200 truncate">{m.title}</div>
              {m.url && <div className="text-[10px] text-blue-400/70 truncate mt-0.5 font-mono">{m.url}</div>}
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {new Date(m.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
          {marks.length === 0 && !creating && (
            <div className="p-4 text-xs text-zinc-600 text-center">
              {t('marks.empty')}
            </div>
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
          />
        )}
        {!selected && !creating && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600 text-sm gap-2">
            <span>{t('marks.placeholder')}</span>
            <span className="text-[10px] text-zinc-700">{t('marks.placeholderSub')}</span>
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
        <div className="bg-green-500/10 border border-green-500/20 rounded px-3 py-2 text-[10px] text-green-400">
          {t('marks.autoCaptured', { title: browserTab.title || '' })}
        </div>
      )}
      {!initial && !browserTab?.connected && (
        <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-[10px] text-zinc-500">
          {t('marks.cdpHint')}
        </div>
      )}

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('marks.fieldTitle')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={t('marks.fieldTitlePlaceholder')}
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 focus:border-red-500 outline-none" />
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('marks.fieldUrl')}</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="w-full mt-0.5 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-200 focus:border-red-500 outline-none font-mono text-xs" />
      </div>

      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('marks.fieldNote')}</label>
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

function QuickMarkDetail({ mark, onUpdate, onDelete }: {
  mark: QuickMark
  onUpdate: () => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const { t } = useI18n()

  if (editing) {
    return <QuickMarkForm browserTab={null} initial={mark} onSave={() => { setEditing(false); onUpdate() }} onCancel={() => setEditing(false)} />
  }

  const handleDelete = async (): Promise<void> => {
    await window.redlog.quickmarks.delete(mark.id)
    onDelete()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-200">{mark.title}</h3>
          {mark.url && (
            <div className="text-xs text-blue-400 font-mono mt-1 break-all">{mark.url}</div>
          )}
          <div className="text-[10px] text-zinc-500 mt-1">
            {new Date(mark.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setEditing(true)} className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700">{t('marks.edit')}</button>
          <button onClick={handleDelete} className="px-2 py-1 text-[10px] bg-zinc-800 text-red-400 rounded hover:bg-zinc-700">{t('marks.delete')}</button>
        </div>
      </div>

      {mark.note && (
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('marks.fieldNote')}</label>
          <div className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900 rounded p-3 border border-zinc-800">{mark.note}</div>
        </div>
      )}

      {Object.keys(mark.context).length > 0 && (
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">{t('marks.autoContext')}</label>
          <div className="mt-1 bg-zinc-900 rounded p-3 border border-zinc-800 space-y-1">
            {mark.context.browserUrl && (
              <div className="text-[10px]">
                <span className="text-zinc-500">{t('marks.browserUrl')}</span>{' '}
                <span className="text-blue-400 font-mono">{mark.context.browserUrl}</span>
              </div>
            )}
            {mark.context.browserTitle && (
              <div className="text-[10px]">
                <span className="text-zinc-500">{t('marks.pageTitle')}</span>{' '}
                <span className="text-zinc-300">{mark.context.browserTitle}</span>
              </div>
            )}
            {mark.context.externalIP && (
              <div className="text-[10px]">
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
