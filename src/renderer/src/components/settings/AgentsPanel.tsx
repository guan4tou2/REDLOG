import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '../Button'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { confirmGraded } from '../ConfirmDialog'
import { SourceLastSeen } from './SourceLastSeen'
import { CheckRow } from './CheckRow'
import { useCaptureHealth } from '../../lib/useCaptureHealth'
import type { OfficialAgentPlugin } from '../../../../core/plugins/official-agents'
import type { AgentKind, AgentCaptureSourceConfig } from '../../../../core/agent-capture-policy'

type T = (key: string, vars?: Record<string, string | number>) => string
type Source = { id: string; label: string; root: string; detected: boolean }

// One source entry, one place.
//
// #435: the operator should be able to read a source's whole story from the
// row that describes it — is the integration installed on this machine, is it
// recording for THIS project, what it reads, when it last delivered, and what
// to do next when it is not. The three facts that used to live in three
// different screens (this panel, Plugins, the capture-health card) are now
// told here, in the health card's own vocabulary, with the recovery action
// next to the sentence that says something is wrong.
function AgentRow({ item, source, active, config, setConfig, t, mutate, busy, health, sessions }: {
  item: OfficialAgentPlugin; source?: Source; active: boolean; config: ConfigState; setConfig: (c: ConfigState) => void; t: T
  mutate: (kind: AgentKind, operation: 'install' | 'uninstall') => Promise<void>; busy: boolean
  sessions: Array<{ sessionId: string; cwd?: string; recording: boolean }>
  health?: CaptureSourceInfo
}): JSX.Element {
  const latest = useRef(config); latest.current = config
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const value = config.agentTailer?.sources?.[item.agentKind] ?? {}
  const paths = value.workPaths ?? []
  const authorized = value.installationId === item.installationId && !!item.installationId
  const scopeChanged = typeof value.scopeChangedAt === 'number'
  // Recording for this project is the operator's intent AND a live plugin —
  // the health snapshot is not used for it, because it is taken on a poll and
  // would contradict the checkbox the operator just ticked until the next
  // poll. The snapshot answers the older question: when did something last
  // arrive.
  const projectRecording = value.enabled === true && authorized && active
  const update = (next: AgentCaptureSourceConfig): void => {
    const current = latest.current
    setConfig({ ...current, agentTailer: { ...current.agentTailer, sources: { ...current.agentTailer?.sources, [item.agentKind]: next } } })
  }
  /** A scope change stops recording and says so.
   *
   *  The marker is only set when the source WAS recording: widening the range
   *  of something that never recorded is a setup step, not a change of an
   *  agreement, and saying "scope changed" there would be a false alarm.
   *
   *  The current source is read from the latest config rather than from this
   *  render's closure — the pick that changes the scope resolves a promise
   *  later, by which time the row may have re-rendered. */
  const changeScope = (nextPaths: string[]): void => {
    const current = latest.current.agentTailer?.sources?.[item.agentKind] ?? {}
    const wasRecording = current.enabled === true
    update({
      ...current,
      workPaths: nextPaths,
      enabled: false,
      startedAt: undefined,
      scopeChangedAt: wasRecording ? Date.now() : undefined
    })
  }
  const pick = async (): Promise<void> => {
    const project = latest.current.engagement.id
    setPicking(true); setError(null)
    try {
      const dir = await window.redlog.hookConfig.pickPath(t('settings.agents.pickWork'))
      if (!dir || latest.current.engagement.id !== project) return
      const current = latest.current.agentTailer?.sources?.[item.agentKind] ?? {}
      if (!current.workPaths?.includes(dir)) changeScope([...(current.workPaths ?? []), dir])
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setPicking(false) }
  }
  /** Removing the integration is a machine-wide change, and the operator has
   *  to be told what stops and what stays before it happens — not after. */
  const uninstall = async (): Promise<void> => {
    const ok = await confirmGraded({
      title: t('settings.agents.removeTitle'),
      message: t('settings.agents.removeWhy'),
      level: 'plain',
      confirmLabel: t('settings.agents.removeConfirm'),
      cancelLabel: t('common.cancel'),
      consequences: [t('settings.agents.removeStops'), t('settings.agents.removeKeeps')]
    })
    if (!ok) return
    await mutate(item.agentKind, 'uninstall')
  }
  const pickSource = async (): Promise<void> => {
    const project = latest.current.engagement.id
    setPicking(true); setError(null)
    try {
      const root = await window.redlog.hookConfig.pickPath(t('settings.agents.changeSource'))
      if (!root || latest.current.engagement.id !== project) return
      const current = latest.current.agentTailer?.sources?.[item.agentKind] ?? {}
      if (root !== (current.sourceRoot ?? source?.root)) update({ ...current, sourceRoot: root, enabled: false, startedAt: undefined, scopeChangedAt: current.enabled ? Date.now() : undefined })
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setPicking(false) }
  }
  const root = value.sourceRoot ?? source?.root
  return <section aria-label={source?.label ?? item.name} data-testid={`agent-source-${item.agentKind}`} data-detected={source?.detected ? 'true' : 'false'} className="py-4 space-y-3 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <strong className="text-sm text-redlog-text">{source?.label ?? item.name}</strong>
      {item.state === 'update-available' ? <Button level="secondary" type="button" data-testid={`agent-update-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'install')}>{t('settings.agents.updateCapture')}</Button> : item.state === 'not-installed' ? <Button level="secondary" type="button" data-testid={`agent-install-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'install')}>{t('settings.agents.installCapture')}</Button>
        : item.state === 'installed' && !active ? <Button level="secondary" type="button" data-testid={`agent-restore-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'install')}>{t('settings.agents.restoreCapture')}</Button>
        : item.state === 'installed' ? <CheckRow
          inputTestId={`agent-enabled-${item.agentKind}`}
          checked={projectRecording}
          disabled={busy || picking || !paths.length}
          onChange={(next) => update({ ...value, enabled: next, installationId: item.installationId, startedAt: next ? Date.now() : value.startedAt, scopeChangedAt: undefined })}
          label={t(scopeChanged ? 'settings.agents.confirmScope' : 'settings.agents.enableProject')}
        /> : null}
    </div>
    {(item.state === 'conflict' || item.state === 'error') && <div className="space-y-2"><p role="alert" className="text-xs text-red-400 break-words">{item.error}</p><Button level="quiet" onClick={() => { void window.redlog.plugins.openFolder().catch(e => setError(String(e))) }}>{t('plugins.openFolder')}</Button></div>}
    {health?.lastError && <p role="alert" className="text-xs text-red-400 break-words">{health.lastError.message}</p>}
    {item.state === 'installed' && <>
      {scopeChanged && <p role="status" data-testid={`agent-scope-changed-${item.agentKind}`} className="text-xs text-amber-400">{t('settings.agents.scopeChanged')}</p>}
      <div className="space-y-2">
        {paths.length > 0 && <ul aria-label={t('settings.agents.projectWork')} className="space-y-1">{paths.map(dir => <li key={dir} className="flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-all font-mono">{dir}</span><Button level="secondary" type="button" disabled={busy || picking} aria-label={t('settings.agents.removeWork', { path: dir })} onClick={() => changeScope(paths.filter(p => p !== dir))}>{t('settings.agents.removeDirectory')}</Button></li>)}</ul>}
        <Button level="secondary" type="button" data-testid={`agent-add-path-${item.agentKind}`} disabled={busy || picking} onClick={() => void pick()}>{t('settings.agents.pickWork')}</Button>
      </div>
      {sessions.length > 0 && <details className="text-xs"><summary className="min-h-8 content-center cursor-pointer text-redlog-text-dim">{t('settings.agents.sessions')} ({sessions.length})</summary><ul className="space-y-2" aria-label={t('settings.agents.sessions')}>{sessions.map(session => {
        const excluded = value.excludedSessions?.includes(session.sessionId) === true
        return <li key={session.sessionId} className="flex flex-wrap items-center gap-2 text-xs">
          <code className="min-w-0 flex-1 break-all">{session.sessionId}</code>
          <span className="text-redlog-text-dim">{t(excluded ? 'settings.agents.sessionExcluded' : session.recording ? 'settings.agents.sessionRecording' : 'settings.agents.sessionPaused')}</span>
          <Button level="secondary" type="button" disabled={busy || picking || !projectRecording} data-testid={`agent-session-${session.sessionId}`} onClick={() => {
            const next = new Set(value.excludedSessions ?? [])
            if (excluded) next.delete(session.sessionId); else next.add(session.sessionId)
            update({ ...value, excludedSessions: [...next], ...(excluded ? { sessionStarts: { ...value.sessionStarts, [session.sessionId]: Date.now() } } : {}) })
          }}>{t(excluded ? 'settings.agents.allowSession' : 'settings.agents.excludeSession')}</Button>
        </li>
      })}</ul></details>}
      {!projectRecording && paths.length > 0 && <p className="text-xs text-amber-400">{t('settings.agents.captureBoundary')}</p>}
      <SourceLastSeen source={health} t={t} />
      <details className="text-xs space-y-2" data-testid={`agent-details-${item.agentKind}`}>
        <summary className="min-h-8 content-center cursor-pointer text-redlog-text-dim">{t('settings.agents.sourceSettings')}</summary>
        <div className="space-y-2 pt-2">
          <p className="text-redlog-text-dim">{t(source?.detected ? 'settings.agents.detected' : 'settings.agents.notDetected')}</p>
          <code className="block break-all" data-testid={`agent-root-${item.agentKind}`}>{root}</code>
          <div className="flex flex-wrap gap-2">
            <Button level="secondary" type="button" data-testid={`agent-source-path-${item.agentKind}`} disabled={busy || picking} onClick={() => void pickSource()}>{t('settings.agents.changeSource')}</Button>
            {value.sourceRoot !== undefined && <Button level="secondary" type="button" disabled={busy || picking} onClick={() => update({ ...value, sourceRoot: undefined, enabled: false, startedAt: undefined, scopeChangedAt: value.enabled ? Date.now() : undefined })}>{t('settings.agents.defaultSource')}</Button>}
            <Button level="secondary" type="button" data-testid={`agent-remove-${item.agentKind}`} disabled={busy || picking} onClick={() => void uninstall()}>{t('settings.agents.removeCapture')}</Button>
          </div>
        </div>
      </details>
    </>}
    {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}
  </section>
}

export default function AgentsPanel({ t, config, setConfig }: { t: T; config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
  const [items, setItems] = useState<OfficialAgentPlugin[] | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [sessions, setSessions] = useState<Array<{ agentKind: string; sessionId: string; cwd?: string; recording: boolean }>>([])
  const [active, setActive] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  // The same snapshot the dashboard's capture card reads, so the row here and
  // the card there cannot disagree about when a source last delivered.
  const agentSignature = JSON.stringify(config.agentTailer?.sources ?? {})
  const { health, refresh: refreshHealth } = useCaptureHealth(5_000, agentSignature)
  const load = useCallback(async () => {
    const token = ++generation.current; setError(null)
    try {
      const [catalog, detected, plugins] = await Promise.all([window.redlog.plugins.officialAgents(), window.redlog.agents.sources(Object.fromEntries(Object.entries(config.agentTailer?.sources ?? {}).flatMap(([kind, source]) => source?.sourceRoot ? [[kind, source.sourceRoot]] : []))), window.redlog.plugins.list()])
      if (token !== generation.current) return
      setItems(catalog); setSources(detected); setActive((plugins as Array<{ id: string; status: string }>).filter(p => p.status === 'active').map(p => p.id))
    } catch (e) { if (token === generation.current) setError(String((e as Error).message ?? e)) }
  }, [config.engagement.id, agentSignature])
  useEffect(() => { void load(); return () => { ++generation.current } }, [load, config.engagement.id, agentSignature])
  useEffect(() => {
    let current = true
    const refresh = async (): Promise<void> => {
      try { const next = await window.redlog.agents.sessions(); if (current) setSessions(next) }
      catch (e) { if (current) { setSessions([]); setError(String((e as Error).message ?? e)) } }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5_000)
    return () => { current = false; clearInterval(timer) }
  }, [config.engagement.id, agentSignature])
  const mutate = async (kind: AgentKind, operation: 'install' | 'uninstall'): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const result = await (operation === 'install' ? window.redlog.plugins.installOfficialAgent(kind) : window.redlog.plugins.uninstallOfficialAgent(kind))
      await load()
      refreshHealth()
      if (!result.ok) setError(result.error)
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <FieldGroup title={t('settings.agents')}>
    {error && <div role="alert" className="mb-3 text-xs text-red-400"><p>{error}</p><Button level="secondary" type="button" onClick={() => void load()} className="underline">{t('common.retry')}</Button></div>}
    {!items && !error && <p role="status" className="text-xs text-redlog-text-dim">{t('common.loading')}</p>}
    <div data-testid="agent-sources" className="divide-y divide-redlog-border">{items?.map(item => <AgentRow key={item.agentKind} item={item} source={sources.find(s => s.id === item.agentKind)} active={active.includes(item.pluginId)} config={config} setConfig={setConfig} t={t} mutate={mutate} busy={busy} sessions={sessions.filter(s => s.agentKind === item.agentKind)} health={health?.sources.find(s => s.id === `agent-${item.agentKind}`)} />)}</div>
    {items?.some(item => item.state === 'installed') && <CheckRow
      checked={config.agentTailer?.emitThinking ?? false}
      onChange={(next) => setConfig({ ...config, agentTailer: { ...config.agentTailer, emitThinking: next } })}
      label={t('settings.agents.emitThinking')}
    />}
  </FieldGroup>
}
