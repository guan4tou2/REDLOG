import { useState, useEffect, useRef, useCallback } from 'react'
import { FieldGroup, type ConfigState } from './SettingsShared'
import type { OfficialAgentPlugin } from '../../../../core/plugins/official-agents'
import type { AgentKind, AgentCaptureSourceConfig } from '../../../../core/agent-capture-policy'

type T = (key: string, vars?: Record<string, string | number>) => string
type Source = { id: string; label: string; root: string; detected: boolean }
function AgentRow({ item, source, active, config, setConfig, t, mutate, busy }: {
  item: OfficialAgentPlugin; source?: Source; active: boolean; config: ConfigState; setConfig: (c: ConfigState) => void; t: T
  mutate: (kind: AgentKind, operation: 'install' | 'uninstall') => Promise<void>; busy: boolean
}): JSX.Element {
  const latest = useRef(config); latest.current = config
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const value = config.agentTailer?.sources?.[item.agentKind] ?? {}
  const paths = value.workPaths ?? []
  const authorized = value.installationId === item.installationId && !!item.installationId
  const update = (next: AgentCaptureSourceConfig): void => {
    const current = latest.current
    setConfig({ ...current, agentTailer: { ...current.agentTailer, sources: { ...current.agentTailer?.sources, [item.agentKind]: next } } })
  }
  const pick = async (): Promise<void> => {
    const project = latest.current.engagement.id
    setPicking(true); setError(null)
    try {
      const dir = await window.redlog.hookConfig.pickPath(t('settings.agents.pickWork'))
      if (!dir || latest.current.engagement.id !== project) return
      const current = latest.current.agentTailer?.sources?.[item.agentKind] ?? {}
      if (!current.workPaths?.includes(dir)) update({ ...current, workPaths: [...(current.workPaths ?? []), dir], enabled: false, startedAt: undefined })
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setPicking(false) }
  }
  return <div data-testid={`agent-source-${item.agentKind}`} data-detected={source?.detected ? 'true' : 'false'} className="rounded border border-redlog-border bg-redlog-surface p-3 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="text-sm text-redlog-text">{source?.label ?? item.name}</strong>
      {item.state === 'not-installed' ? <button type="button" data-testid={`agent-install-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'install')} className="rounded bg-redlog-elevated px-3 py-1.5 text-xs text-redlog-text disabled:opacity-40">{t('settings.agents.installCapture')}</button>
        : item.state === 'installed' ? <button type="button" data-testid={`agent-remove-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'uninstall')} className="text-xs text-redlog-text-dim underline disabled:opacity-40">{t('settings.agents.removeCapture')}</button> : null}
    </div>
    <p className="text-xs text-redlog-text-dim">{t(item.state === 'installed' ? 'settings.agents.installedHere' : 'settings.agents.notInstalled')}</p>
    {source && <p className="text-xs break-all text-redlog-text-faint">{t(source.detected ? 'settings.agents.detected' : 'settings.agents.notDetected')} · {source.root}</p>}
    {(item.state === 'conflict' || item.state === 'error') && <p role="alert" className="text-xs text-red-400 break-words">{item.error}</p>}
    {item.state === 'installed' && <>
      {!active && <p className="text-xs text-amber-400">{t('settings.agents.pluginDisabled')}</p>}
      <p className="text-xs text-redlog-text-dim">{t('settings.agents.projectWork')}</p>
      <ul className="space-y-1">{paths.map(dir => <li key={dir} className="flex items-center gap-2 text-xs"><span title={dir} className="min-w-0 flex-1 truncate font-mono">{dir}</span><button type="button" disabled={busy} aria-label={t('settings.agents.removeWork', { path: dir })} onClick={() => update({ ...value, workPaths: paths.filter(p => p !== dir), enabled: false, startedAt: undefined })} className="text-redlog-text-dim underline">{t('settings.agents.removeDirectory')}</button></li>)}</ul>
      <button type="button" data-testid={`agent-add-path-${item.agentKind}`} disabled={busy || picking} onClick={() => void pick()} className="text-xs underline text-redlog-text-dim disabled:opacity-40">{t('settings.agents.pickWork')}</button>
      {!paths.length && <p className="text-xs text-amber-400">{t('settings.agents.noWork')}</p>}
      <label className="flex items-center gap-2 text-xs text-redlog-text"><input type="checkbox" data-testid={`agent-enabled-${item.agentKind}`} checked={value.enabled === true && authorized} disabled={busy || !active || !paths.length} onChange={e => update({ ...value, enabled: e.target.checked, installationId: item.installationId, startedAt: e.target.checked ? Date.now() : value.startedAt })} className="accent-red-600" />{t('settings.agents.enableProject')}</label>
    </>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </div>
}

export default function AgentsPanel({ t, config, setConfig }: { t: T; config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
  const [items, setItems] = useState<OfficialAgentPlugin[] | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [active, setActive] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const token = ++generation.current; setError(null)
    try {
      const [catalog, detected, plugins] = await Promise.all([window.redlog.plugins.officialAgents(), window.redlog.agents.sources(), window.redlog.plugins.list()])
      if (token !== generation.current) return
      setItems(catalog); setSources(detected); setActive((plugins as Array<{ id: string; status: string }>).filter(p => p.status === 'active').map(p => p.id))
    } catch (e) { if (token === generation.current) setError(String((e as Error).message ?? e)) }
  }, [])
  useEffect(() => { void load(); return () => { ++generation.current } }, [load])
  const mutate = async (kind: AgentKind, operation: 'install' | 'uninstall'): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const result = await (operation === 'install' ? window.redlog.plugins.installOfficialAgent(kind) : window.redlog.plugins.uninstallOfficialAgent(kind))
      await load()
      if (!result.ok) setError(result.error)
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <FieldGroup title={t('settings.agents')}>
    <p className="text-xs text-redlog-text-dim mb-3">{t('settings.agents.optionalHint')}</p>
    <p className="text-xs text-redlog-text-faint mb-3">{t('settings.agents.fromNow')}</p>
    {error && <div role="alert" className="mb-3 text-xs text-red-400"><p>{error}</p><button type="button" onClick={() => void load()} className="underline">{t('common.retry')}</button></div>}
    {!items && !error && <p role="status" className="text-xs text-redlog-text-dim">{t('common.loading')}</p>}
    <div data-testid="agent-sources" className="space-y-3">{items?.map(item => <AgentRow key={item.agentKind} item={item} source={sources.find(s => s.id === item.agentKind)} active={active.includes(item.pluginId)} config={config} setConfig={setConfig} t={t} mutate={mutate} busy={busy} />)}</div>
    <label className="flex items-center gap-2 mt-3 text-xs text-redlog-text"><input type="checkbox" checked={config.agentTailer?.emitThinking ?? false} onChange={e => setConfig({ ...config, agentTailer: { ...config.agentTailer, emitThinking: e.target.checked } })} className="accent-red-600" />{t('settings.agents.emitThinking')}</label>
    <p className="text-xs text-redlog-text-faint mt-2">{t('settings.agents.selfExclusionHint')}</p>
  </FieldGroup>
}
