import { useState, useEffect } from 'react'
import { toast } from '../Toast'
import { FieldGroup, type ConfigState } from './SettingsShared'

export default function AgentsPanel({
  t, config, setConfig
}: {
  t: (key: string, vars?: Record<string, string | number>) => string
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const at = (config.agentTailer ?? { enabled: false, emitThinking: false }) as { enabled: boolean; emitThinking?: boolean }
  const patch = (delta: Partial<typeof at>): void => {
    setConfig({ ...config, agentTailer: { ...at, ...delta } })
  }
  return (
    <FieldGroup title={t('settings.agents')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.agents.hint')}</p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={at.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.agents.enable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint pl-6">{t('settings.agents.enableHint')}</p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={at.emitThinking ?? false}
            onChange={(e) => patch({ emitThinking: e.target.checked })}
            className="accent-red-600"
            disabled={!at.enabled}
          />
          <span className={`text-xs ${at.enabled ? 'text-redlog-text' : 'text-redlog-text-faint'}`}>
            {t('settings.agents.emitThinking')}
          </span>
        </label>
        <p className="text-xs text-redlog-text-faint pl-6">{t('settings.agents.emitThinkingHint')}</p>
        <p className="text-xs text-redlog-text-faint mt-3 border-t border-redlog-border pt-2">
          {t('settings.agents.selfExclusionHint')}
        </p>
      </div>
    </FieldGroup>
  )
}

// Inclusion list for agent transcript tailers. An empty list records every
// discovered session; operators can limit capture to engagement directories.
export function HookWatchPathsPanel({ t }: { t: (k: string, v?: Record<string, string | number>) => string }): JSX.Element {
  const [watchPaths, setWatchPaths] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    window.redlog.hookConfig.get().then((c) => {
      setWatchPaths(c.watchPaths || [])
    }).catch(() => {})
  }, [])
  const commit = async (next: string[]): Promise<void> => {
    setWatchPaths(next)
    setDirty(true)
    await window.redlog.hookConfig.save({ watchPaths: next })
    setDirty(false)
    toast(t('settings.hookWatchPaths.saved'), 'success')
  }
  const addPath = async (p: string): Promise<void> => {
    const clean = p.trim()
    if (!clean) return
    if (watchPaths.includes(clean)) return
    await commit([...watchPaths, clean])
  }
  const removePath = async (p: string): Promise<void> => {
    await commit(watchPaths.filter((x) => x !== p))
  }
  const pickFolder = async (): Promise<void> => {
    const p = await window.redlog.hookConfig.pickPath()
    if (p) await addPath(p)
  }
  return (
    <FieldGroup title={t('settings.hookWatchPaths.title')}>
      <p className="text-xs text-redlog-text-dim mb-3">{t('settings.hookWatchPaths.hint')}</p>
      <div className="space-y-1 mb-2">
        {watchPaths.length === 0 ? (
          <p className="text-xs text-amber-500 font-mono px-2 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded">
            {t('settings.hookWatchPaths.empty')}
          </p>
        ) : watchPaths.map((p) => (
          <div key={p} className="flex items-center gap-2 px-2 py-1 bg-redlog-surface border border-redlog-border rounded">
            <span title={p} className="text-xs font-mono text-redlog-text flex-1 truncate">{p}</span>
            <button
              onClick={() => removePath(p)}
              className="text-xs text-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
              title={t('settings.hookWatchPaths.remove')}
              aria-label={t('settings.hookWatchPaths.remove')}
            >{'\u2715'}</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath(draft); setDraft('') } }}
          placeholder="C:\\Users\\user\\Desktop\\engagement"
          className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
        />
        <button
          onClick={pickFolder}
          className="px-3 py-1 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
          title={t('settings.hookWatchPaths.pickFolder')}
        >{'\uD83D\uDCC1'} {t('settings.hookWatchPaths.pickFolder')}</button>
        <button onClick={() => { addPath(draft); setDraft('') }} disabled={!draft.trim() || dirty} className="px-3 py-1 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-40">+</button>
      </div>
    </FieldGroup>
  )
}
