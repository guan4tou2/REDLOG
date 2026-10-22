import { useState, useEffect, useRef, useCallback } from 'react'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { Button } from '../Button'
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
function AgentRow({ item, source, active, config, setConfig, t, mutate, busy, onOpenPlugins, health }: {
  item: OfficialAgentPlugin; source?: Source; active: boolean; config: ConfigState; setConfig: (c: ConfigState) => void; t: T
  mutate: (kind: AgentKind, operation: 'install' | 'uninstall') => Promise<void>; busy: boolean
  onOpenPlugins?: () => void
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
  return <div data-testid={`agent-source-${item.agentKind}`} data-detected={source?.detected ? 'true' : 'false'} className="rounded border border-redlog-border bg-redlog-surface p-3 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="text-sm text-redlog-text">{source?.label ?? item.name}</strong>
      {item.state === 'not-installed' ? <button type="button" data-testid={`agent-install-${item.agentKind}`} disabled={busy} onClick={() => void mutate(item.agentKind, 'install')} className="rounded bg-redlog-elevated px-3 py-1.5 text-xs text-redlog-text disabled:opacity-40">{t('settings.agents.installCapture')}</button>
        : item.state === 'installed' ? <button type="button" data-testid={`agent-remove-${item.agentKind}`} disabled={busy} onClick={() => void uninstall()} className="text-xs text-redlog-text-dim underline disabled:opacity-40">{t('settings.agents.removeCapture')}</button> : null}
    </div>
    {/* Two axes, named. "Installed" is about this computer; "recording" is
        about this project. They were one sentence, so an operator who had
        installed the integration everywhere could not tell which one the row
        was answering. */}
    <p className="text-xs text-redlog-text-dim">
      {t(item.state === 'installed' ? 'settings.agents.installedHere' : 'settings.agents.notInstalled')}
      {item.state === 'installed' && <> · {t(projectRecording ? 'settings.agents.recordingForProject' : 'settings.agents.notRecordingForProject')}</>}
    </p>
    {/* Transcript folder. This line used to say "start the AI tool, then
        reopen this project" whenever the folder was missing — including when
        the integration was not installed at all, where following that advice
        records nothing and there is no way to tell why. The folder is a fact
        about the AI tool; whether it can be read is a fact about the
        integration. Only the installed row has anything to do with it, and
        only there is the advice actionable. */}
    {source && (
      <p className="text-xs break-all text-redlog-text-faint">
        {t(source.detected ? 'settings.agents.detected' : 'settings.agents.notDetected')} · {source.root}
        {!source.detected && item.state === 'installed' && <> — {t('settings.agents.notDetectedHint')}</>}
      </p>
    )}
    {/* What it last delivered. The health card says this for the whole
        capture; here it is the source's own row, so the operator does not have
        to leave the page to find out whether anything is arriving. */}
    <SourceLastSeen source={health} t={t} />
    {(item.state === 'conflict' || item.state === 'error') && <p role="alert" className="text-xs text-red-400 break-words">{item.error}</p>}
    {health?.lastError && <p role="alert" className="text-xs text-red-400 break-words">{health.lastError.message}</p>}
    {item.state === 'installed' && <>
      {!active && <div className="space-y-1">
        <p className="text-xs text-amber-400">{t('settings.agents.pluginDisabled')}</p>
        {onOpenPlugins && <Button level="quiet" disabled={busy || picking} onClick={onOpenPlugins}>{t('settings.openPlugins')}</Button>}
      </div>}
      <p className="text-xs text-redlog-text-dim">{t('settings.agents.projectWork')}</p>
      <ul className="space-y-1">{paths.map(dir => <li key={dir} className="flex items-center gap-2 text-xs"><span title={dir} className="min-w-0 flex-1 truncate font-mono">{dir}</span><button type="button" disabled={busy} aria-label={t('settings.agents.removeWork', { path: dir })} onClick={() => changeScope(paths.filter(p => p !== dir))} className="text-redlog-text-dim underline">{t('settings.agents.removeDirectory')}</button></li>)}</ul>
      <button type="button" data-testid={`agent-add-path-${item.agentKind}`} disabled={busy || picking} onClick={() => void pick()} className="text-xs underline text-redlog-text-dim disabled:opacity-40">{t('settings.agents.pickWork')}</button>
      {!paths.length && <p className="text-xs text-amber-400">{t('settings.agents.noWork')}</p>}
      {/* The scope moved under a recording source. The sentence says which
          happened, and the checkbox below becomes the one action that resolves
          it — one control, not two ways to do the same thing. */}
      {scopeChanged
        ? <p role="status" data-testid={`agent-scope-changed-${item.agentKind}`} className="text-xs text-amber-400">{t('settings.agents.scopeChanged')}</p>
        : active && paths.length > 0 && !projectRecording && <p role="status" className="text-xs text-amber-400">{t('settings.agents.notRecording')}</p>}
      <CheckRow
        inputTestId={`agent-enabled-${item.agentKind}`}
        checked={value.enabled === true && authorized}
        disabled={busy || !active || !paths.length}
        onChange={(next) => update({
          ...value,
          enabled: next,
          installationId: item.installationId,
          startedAt: next ? Date.now() : value.startedAt,
          scopeChangedAt: undefined
        })}
        label={t(scopeChanged ? 'settings.agents.confirmScope' : 'settings.agents.enableProject')}
      />
    </>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </div>
}

export default function AgentsPanel({ t, config, setConfig, onOpenPlugins }: { t: T; config: ConfigState; setConfig: (c: ConfigState) => void; onOpenPlugins?: () => void }): JSX.Element {
  const [items, setItems] = useState<OfficialAgentPlugin[] | null>(null)
  const [sources, setSources] = useState<Source[]>([])
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
      refreshHealth()
      if (!result.ok) setError(result.error)
    } catch (e) { setError(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <FieldGroup title={t('settings.agents')}>
    <p className="text-xs text-redlog-text-dim mb-3">{t('settings.agents.optionalHint')}</p>
    <p className="text-xs text-redlog-text-faint mb-3">{t('settings.agents.fromNow')}</p>
    {error && <div role="alert" className="mb-3 text-xs text-red-400"><p>{error}</p><button type="button" onClick={() => void load()} className="underline">{t('common.retry')}</button></div>}
    {!items && !error && <p role="status" className="text-xs text-redlog-text-dim">{t('common.loading')}</p>}
    <div data-testid="agent-sources" className="space-y-3">{items?.map(item => <AgentRow key={item.agentKind} item={item} source={sources.find(s => s.id === item.agentKind)} active={active.includes(item.pluginId)} config={config} setConfig={setConfig} t={t} mutate={mutate} busy={busy} onOpenPlugins={onOpenPlugins} health={health?.sources.find(s => s.id === `agent-${item.agentKind}`)} />)}</div>
    <CheckRow
      checked={config.agentTailer?.emitThinking ?? false}
      onChange={(next) => setConfig({ ...config, agentTailer: { ...config.agentTailer, emitThinking: next } })}
      label={t('settings.agents.emitThinking')}
    />
    <p className="text-xs text-redlog-text-faint mt-2">{t('settings.agents.selfExclusionHint')}</p>
  </FieldGroup>
}
