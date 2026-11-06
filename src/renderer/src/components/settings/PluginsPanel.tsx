import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { Button } from '../Button'
import { toast, toastUndo } from '../Toast'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { confirmGraded } from '../ConfirmDialog'
import { useCaptureHealthState } from '../../lib/useCaptureHealth'
import type { AgentKind } from '../../../../core/agent-capture-policy'
import type { OfficialAgentPlugin, OfficialAgentMutation } from '../../../../core/plugins/official-agents'
import { Modal } from '../Modal'
import { CAPTURE_PACKS } from '../../../../core/capture-packs'
import { matchesQuery } from '../../lib/textQuery'
import { pluginViewModel, needsAttention, matchesPluginFilter, mergeOfficialCatalog, officialProjectLevel, officialHealth, type PluginFilter, type PluginView, type PluginViewModel } from '../../lib/pluginViewModel'
import PluginDetailPanel from './PluginDetailPanel'
import { PluginRow } from './PluginRow'

type T = (key: string, vars?: Record<string, string | number>) => string

const PROFILE_LINE = {
  native: 'plugins.profileNative',
  pty: 'plugins.profilePty',
  relayed: 'plugins.profileRelayed'
} as const

// SS10: two levels, not four. This page used to hold sub-tabs for installed
// and marketplace, and the marketplace held its own for publishers and
// revocations — three levels below a second-level tab, when the standard
// allows two.
//
// The marketplace is now gone rather than flattened. Browsing a registry,
// trusting publishers by fingerprint, and reading revocation lists are the
// machinery of distributing capture code, and distribution is not what this
// product is for. What stays is the part an operator needs to answer "is
// anything capturing that I did not put there" — the installed list.

// Five of the eight bundled manifests were never a choice made here.
//
//   starter-pack   declares the shell hooks, the Codex wrapper and the
//                  mitmproxy addon -- what RedLog always ships. Settings ▸
//                  指令與終端 lists them; this row could switch them all off
//                  from a page that does not say that is what it does.
//   builtin-tools  is the tool → target table core reads. Not a choice.
//   pack-*         are the capture packs Settings ▸ 擷取 pack already owns,
//                  per project, with words that say what they record. Two
//                  switches for one thing, and they do not even agree on
//                  scope: that page is per project, this one is every project
//                  at once.
//
// Derived from CAPTURE_PACKS rather than written out, so a pack added later
// leaves this page without anyone having to remember a string list.
const OWNED_ELSEWHERE = new Set<string>([
  'starter-pack',
  'builtin-tools',
  ...Object.values(CAPTURE_PACKS).map((p) => p.pluginId),
  // The three that moved to Settings ▸ 擷取 pack ▸ 外部擷取來源. They ship with
  // RedLog, so they are not plugins -- Burp does not put Proxy and Repeater in
  // Extensions either -- and the switch they had here started nothing: they
  // need root or they rewrite this host's nat rules, so the operator runs the
  // command. A boolean over privileges the app does not hold cannot be honest.
  'c2-tailers', 'pcap-capture', 'transparent-proxy'
])

// Hiding a row hides a CHOICE, never a STATE. `isPackAvailable` requires the
// pack's plugin to be active, and a disable persists in
// ~/.redlog/plugins/state.json -- so a plugin switched off before this filter
// existed would sit disabled forever, with 擷取 pack reporting it unavailable
// and the only control that could bring it back hidden from the operator. A
// row that is off is always shown, because that is the row someone needs.
//
// Spec 066: the official AI integrations are no longer hidden here. This page is
// the one place they are installed, updated and removed; Capture sources keeps
// only the per-project settings and points back at this row.
const isHidden = (p: { id: string; status: string }): boolean =>
  OWNED_ELSEWHERE.has(p.id) && p.status !== 'disabled'

// The manifests describe these packs to whoever maintains them: spec
// numbers, doc paths, the identifiers the code uses, and the reason the
// thing is a manifest at all. None of that is what the operator standing on
// this page is asking, which is "what does this put in my record, and can I
// turn it off" -- and all of it was in English inside a Chinese interface.
// Bundled packs get a translated line each; a user's plugin still speaks for
// itself through its own manifest.

function descriptionOf(p: PluginView, t: T): string {
  if (p.source !== 'bundled') return p.description
  const key = `plugins.builtin.${p.id}`
  const line = t(key)
  return line === key ? p.description : line
}

export default function PluginsPanel({ t, config, focus, onFocusHandled, onOpenCaptureSources }: {
  t: T
  /** Needed for the project axis; without it that axis says it cannot tell. */
  config?: ConfigState
  /** Spec 066 FR-021: the integration to open, from a link on Capture sources.
   *  A new object per request, so asking for the same one again selects it again. */
  focus?: { pluginId: string } | null
  onFocusHandled?: () => void
  /** Spec 066 FR-020: jump to the integration's Capture sources row. View only. */
  onOpenCaptureSources?: (agentKind: string) => void
}): JSX.Element {
  const describe = (p: PluginView): string => descriptionOf(p, t)

  const [loaded, setPlugins] = useState<PluginView[]>([])
  const [catalog, setCatalog] = useState<OfficialAgentPlugin[]>([])
  // Spec 067: the catalog failing is its own error. The plugin list is a different
  // question, and the operator's own plugins must not vanish because of it.
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Loaded plugins and the official catalog meet by pluginId: a not-installed
  // integration has no loaded plugin and would otherwise have no row.
  const plugins = useMemo(() => mergeOfficialCatalog(loaded, catalog), [loaded, catalog])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmGrant, setConfirmGrant] = useState<PluginView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Every answer from main carries the whole list. Only the newest request may
  // replace what is on screen, so a slow reload cannot undo a later disable.
  const newest = useRef(0)

  const api = (window.redlog as unknown as { plugins: {
    list: () => Promise<PluginView[]>
    reload: () => Promise<PluginView[]>
    officialAgents: () => Promise<OfficialAgentPlugin[]>
    installOfficialAgent: (kind: string) => Promise<OfficialAgentMutation>
    uninstallOfficialAgent: (kind: string) => Promise<OfficialAgentMutation>
    openFolder: () => Promise<string>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginView[]>
    grant: (id: string) => Promise<{ ok: boolean; error?: string; profilesError?: string; plugins: PluginView[] }>
    revoke: (id: string) => Promise<PluginView[]>
  } }).plugins

  const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  const applyCatalog = (listed: PluginView[], official: PromiseSettledResult<OfficialAgentPlugin[]>): void => {
    setPlugins(listed)
    if (official.status === 'fulfilled') { setCatalog(official.value); setCatalogError(null) }
    else { setCatalog([]); setCatalogError(errorText(official.reason)) }
  }
  /** Re-read only the catalog (the retry beside its error). */
  const retryCatalog = async (): Promise<void> => {
    const mine = ++newest.current
    const [official] = await Promise.allSettled([api.officialAgents()])
    if (mine !== newest.current) return
    if (official.status === 'fulfilled') { setCatalog(official.value); setCatalogError(null) }
    else setCatalogError(errorText(official.reason))
  }

  // A list that failed to load is not an empty list: the first says "try
  // again", the second says "there is nothing here".
  const load = async (): Promise<void> => {
    const mine = ++newest.current
    setLoading(true); setLoadError(null)
    try {
      const [listed, official] = await Promise.allSettled([api.list(), api.officialAgents()])
      if (listed.status === 'rejected') throw listed.reason
      if (mine === newest.current) applyCatalog(listed.value, official)
    } catch (e) {
      if (mine === newest.current) setLoadError(errorText(e))
    } finally {
      if (mine === newest.current) setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const shown = useMemo(() => plugins.filter((p) => !isHidden(p)), [plugins])
  const vms = useMemo(() => new Map<string, PluginViewModel>(shown.map((p) => [p.id, pluginViewModel(p, describe)])), [shown, describe])
  // A plugin that no longer exists cannot stay selected.
  useEffect(() => { if (selectedId !== null && !vms.has(selectedId)) setSelectedId(null) }, [vms, selectedId])

  const attentionCount = useMemo(() => shown.filter((p) => needsAttention(p)).length, [shown])
  const filterCounts = useMemo<Record<PluginFilter, number>>(() => ({
    all: shown.length,
    installed: shown.filter((p) => matchesPluginFilter(p, 'installed')).length,
    official: shown.filter((p) => matchesPluginFilter(p, 'official')).length,
    attention: attentionCount
  }), [shown, attentionCount])
  const filtered = useMemo(() => shown.filter((p) => {
    const vm = vms.get(p.id)
    if (!vm) return false
    if (!matchesPluginFilter(p, filter)) return false
    return matchesQuery(vm.searchText, query)
  }), [shown, vms, filter, query])

  /** A change that went through but left the shell's profiles as they were is
   *  not a plain success: a revoke or a disable would still be in effect there. */
  const warnIfStale = (reason: string | null | undefined): void => {
    if (reason) toast(t('plugins.profilesStale'), { type: 'warning', detail: reason })
  }

  /** One operation on the plugin list. The screen shows what main answered, never
   *  what the operator asked for: on failure the real list is read back, so a
   *  switch that did not flip does not stay drawn as flipped. */
  const run = async (id: string, op: () => Promise<PluginView[]>, failure: string): Promise<boolean> => {
    const mine = ++newest.current
    setBusy(id)
    try {
      const next = await op()
      if (mine === newest.current) setPlugins(next)
      warnIfStale(next[0]?.profilesError)
      return true
    } catch (e) {
      toast(failure, { type: 'error', why: t('plugins.failedWhy'), detail: errorText(e) })
      void load()
      return false
    } finally {
      setBusy((current) => (current === id ? null : current))
    }
  }

  const doReload = (): Promise<boolean> => run('*', () => api.reload(), t('plugins.reloadFailed'))
  const enable = (p: PluginView): Promise<boolean> =>
    run(p.id, () => api.setEnabled(p.id, true), t('plugins.enableFailed', { name: p.name }))
  const toggle = async (p: PluginView, enabled: boolean): Promise<void> => {
    if (enabled) { await enable(p); return }
    // Disabling is written now, and "disabled" is shown only once main says it
    // is. It used to be drawn at once and written eight seconds later, with a
    // toast that said both — a plugin the operator believed was off kept
    // capturing for the whole window, and for good if the page was left first.
    // Undo is what it says: enabling it again.
    const ok = await run(p.id, () => api.setEnabled(p.id, false), t('plugins.disableFailed', { name: p.name }))
    if (ok) {
      toastUndo(t('plugins.disabled', { name: p.name }), () => { void enable(p) }, {
        type: 'warning',
        why: t('plugins.disabledWhy')
      })
    }
  }
  const grant = async (p: PluginView): Promise<void> => {
    setConfirmGrant(null)
    const mine = ++newest.current
    setBusy(p.id)
    try {
      const r = await api.grant(p.id)
      if (mine === newest.current) setPlugins(r.plugins)
      if (r.ok) {
        if (r.profilesError) warnIfStale(r.profilesError)
        else toast(t('plugins.granted'), 'success')
      } else {
        toast(t('plugins.grantFailed', { name: p.id }), {
          type: 'error',
          // "Unable to run" is about code; a plugin that is only profiles runs nothing.
          why: p.tier === 'privileged' ? t('plugins.grantFailedWhy')
            : (p.terminalProfiles?.length ?? 0) === 0 && (p.captureInstalls?.length ?? 0) > 0
              ? t('plugins.grantFailedWhyInstall') : t('plugins.grantFailedWhyProfiles'),
          detail: r.error
        })
      }
    } catch (e) {
      toast(t('plugins.grantFailed', { name: p.id }), { type: 'error', why: t('plugins.failedWhy'), detail: errorText(e) })
      void load()
    } finally {
      setBusy((current) => (current === p.id ? null : current))
    }
  }
  const revoke = async (p: PluginView): Promise<void> => {
    await run(p.id, () => api.revoke(p.id), t('plugins.revokeFailed', { name: p.name }))
  }

  // One column at every width: the list, or one plugin's detail with a way back.
  // Going into a detail replaces the list, and the list comes back from the top
  // unless its place was kept. The place is taken once, on the way in from the
  // list; refreshing the detail (an enable, an install) must not overwrite it.
  const rootRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<number | null>(null)
  const scroller = (): HTMLElement | null => rootRef.current?.closest<HTMLElement>('[data-testid="settings-content"]') ?? null
  const openDetail = (id: string): void => {
    if (selectedId === null) anchor.current = scroller()?.scrollTop ?? 0
    setSelectedId(id)
  }
  useLayoutEffect(() => {
    const el = scroller()
    if (!el) return
    if (selectedId !== null) { el.scrollTop = 0; return }
    if (anchor.current !== null) { el.scrollTop = anchor.current; anchor.current = null }
  }, [selectedId])
  const selected = vms.get(selectedId ?? '') ? plugins.find((p) => p.id === selectedId) : undefined
  const selectedVm = selected ? vms.get(selected.id) : undefined

  // Spec 066 FR-021/022: a link from Capture sources opens that integration's
  // row — also when it is not installed. Only the selection and the filters
  // move; nothing is written and nothing asks for confirmation.
  useEffect(() => {
    if (!focus || loading) return
    if (!vms.has(focus.pluginId)) { onFocusHandled?.(); return }
    setQuery(''); setFilter('all'); openDetail(focus.pluginId)
    onFocusHandled?.()
  }, [focus, loading, vms])

  // Install / update / remove: the only place they happen (FR-003). What is
  // drawn afterwards is what main now says, read back — not the button pressed.
  const mutateOfficial = async (p: PluginView, op: 'install' | 'uninstall'): Promise<void> => {
    const kind = p.official?.agentKind
    if (!kind) return
    setBusy(p.id)
    const failure = t(op === 'install' ? 'plugins.integration.installFailed' : 'plugins.integration.removeFailed', { name: p.name })
    try {
      const result = await (op === 'install' ? api.installOfficialAgent(kind) : api.uninstallOfficialAgent(kind))
      if (!result.ok) toast(failure, { type: 'error', why: t('plugins.failedWhy'), detail: result.error })
    } catch (e) {
      toast(failure, { type: 'error', why: t('plugins.failedWhy'), detail: errorText(e) })
    }
    try {
      const mine = ++newest.current
      const [listed, official] = await Promise.allSettled([api.list(), api.officialAgents()])
      if (listed.status === 'rejected') throw listed.reason
      if (mine === newest.current) applyCatalog(listed.value, official)
    } catch (e) {
      toast(t('plugins.loadFailed'), { type: 'error', detail: errorText(e) })
    } finally {
      setBusy((current) => (current === p.id ? null : current))
      refreshHealth()
    }
  }
  /** Removing is machine-wide: say what stops and what stays before it happens. */
  const removeOfficial = async (p: PluginView): Promise<void> => {
    const ok = await confirmGraded({
      title: t('settings.agents.removeTitle'),
      message: t('settings.agents.removeWhy'),
      level: 'plain',
      confirmLabel: t('settings.agents.removeConfirm'),
      cancelLabel: t('common.cancel'),
      consequences: [t('settings.agents.removeStops'), t('settings.agents.removeKeeps')]
    })
    if (ok) await mutateOfficial(p, 'uninstall')
  }

  // Project axis and health axis, kept apart (FR-033). Health is the shared
  // snapshot every other reader draws from; a failed read is "unknown".
  const agentSignature = JSON.stringify(config?.agentTailer?.sources ?? {})
  const { health: snapshot, status: healthStatus, refresh: refreshHealth } = useCaptureHealthState(5_000, agentSignature)
  const officialAxes = selected?.official ? (() => {
    const kind = selected.official.agentKind
    const level = officialProjectLevel(selected, config ? (config.agentTailer?.sources?.[kind as AgentKind] ?? {}) : undefined)
    const source = snapshot?.sources.find((s) => s.id === `agent-${kind}`)
    const health = officialHealth(selected, level, { status: healthStatus === 'ok' && snapshot ? 'ok' : 'unknown', source })
    return { level, health }
  })() : undefined

  // What the open dialog asks the operator to approve: code (a third-party
  // tailer, which never runs, is not), and the profiles the plugin declares.
  const confirms = (p: PluginView | null): { code: boolean; profiles: NonNullable<PluginView['terminalProfiles']>; installs: NonNullable<PluginView['captureInstalls']> } => {
    if (!p) return { code: false, profiles: [], installs: [] }
    // A user plugin whose only code is a tailer runs nothing, whatever is
    // agreed; even one that also declares profiles must not be called code.
    const tailerRefused = p.source === 'user' && p.report?.tailers?.state === 'rejected'
    return {
      code: p.tier === 'privileged' && !tailerRefused,
      profiles: p.terminalProfiles ?? [],
      installs: p.captureInstalls ?? []
    }
  }
  const consent = confirms(confirmGrant)
  const consentTitle = consent.code ? t('plugins.consentTitle')
    : consent.profiles.length > 0 ? t('plugins.consentTitleProfiles') : t('plugins.consentTitleInstall')
  const consentBody = !confirmGrant ? '' : consent.code ? t('plugins.consentBody', { name: confirmGrant.name })
    : consent.profiles.length > 0 ? t('plugins.consentBodyProfiles', { name: confirmGrant.name })
      : t('plugins.consentBodyInstall', { name: confirmGrant.name })

  const detail = selected && selectedVm ? (
    <PluginDetailPanel
      p={selected} vm={selectedVm} t={t} busy={busy === selected.id}
      onEnable={() => void enable(selected)} onDisable={() => void toggle(selected, false)}
      onReview={() => setConfirmGrant(selected)} onRevoke={() => void revoke(selected)}
      onBack={() => setSelectedId(null)}
      officialAxes={officialAxes}
      onInstall={() => void mutateOfficial(selected, 'install')} onRemove={() => void removeOfficial(selected)}
      onOpenCaptureSources={onOpenCaptureSources && selected.official ? () => onOpenCaptureSources(selected.official!.agentKind) : undefined}
    />
  ) : null

  const FILTERS: Array<{ id: PluginFilter; label: string }> = [
    { id: 'all', label: t('plugins.filter.all') },
    { id: 'installed', label: t('plugins.filter.installed') },
    { id: 'official', label: t('plugins.filter.official') },
    { id: 'attention', label: t('plugins.filterAttention') }
  ]

  const list = (
    <>
      <div className="flex items-center justify-end mb-2 gap-2">
        <button onClick={() => api.openFolder()}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover shrink-0"
          title={t('plugins.openFolderHint')}>
          {t('plugins.openFolder')}
        </button>
        <Button level="secondary" onClick={doReload} disabled={busy === '*'} className="shrink-0">
          {busy === '*' ? '...' : t('plugins.reload')}
        </Button>
      </div>

      {loaded[0]?.profilesError && (
        <div role="alert" data-testid="plugins-profiles-stale" className="text-xs mb-2 space-y-0.5">
          <p className="text-amber-300">{t('plugins.profilesStale')}</p>
          <p className="text-redlog-text-faint break-all">{loaded[0].profilesError}</p>
        </div>
      )}

      {catalogError !== null && !loadError && (
        <div role="alert" data-testid="plugins-catalog-error" className="text-xs mb-2 space-y-0.5">
          <p className="text-amber-300">{t('plugins.catalogLoadFailed')}</p>
          <p className="text-redlog-text-faint break-all">{catalogError}</p>
          <button type="button" data-testid="plugins-catalog-retry" onClick={() => void retryCatalog()} className="underline text-redlog-cyan hover:text-redlog-text">{t('common.retry')}</button>
        </div>
      )}

      {loading && plugins.length === 0 && !loadError && (
        <p role="status" className="text-xs text-redlog-text-faint py-3">{t('plugins.loading')}</p>
      )}
      {loadError !== null && (
        <div role="alert" data-testid="plugins-load-error" className="text-xs py-3 space-y-1">
          <p className="text-amber-300">{t('plugins.loadFailed')}</p>
          <p className="text-redlog-text-faint break-all">{loadError}</p>
          <button type="button" onClick={() => void load()} className="underline text-redlog-cyan hover:text-redlog-text">{t('common.retry')}</button>
        </div>
      )}
      {!loading && loadError === null && (
        <div className="min-w-0">
          {shown.length === 0 && <p className="text-xs text-redlog-text-faint py-3">{t('plugins.empty')}</p>}
          {shown.length > 0 && (
            <div className="mb-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search" data-testid="plugin-search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('plugins.searchPlaceholder')} aria-label={t('plugins.search')}
                  className="flex-1 min-w-[12rem] bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text focus:outline-none focus:border-red-500"
                />
                <div role="group" aria-label={t('plugins.filter.label')} className="flex items-center gap-1 rounded border border-redlog-border bg-redlog-bg p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id} type="button" data-testid={`plugin-filter-${f.id}`} aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={`px-2 py-1 rounded text-xs whitespace-nowrap transition-colors ${filter === f.id ? 'bg-redlog-elevated text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
                    >{f.label} ({filterCounts[f.id]})</button>
                  ))}
                </div>
              </div>

              <p data-testid="plugin-shown-count" className="text-xs text-redlog-text-faint">
                {t('plugins.shownCount', { count: filtered.length })} · {t('plugins.listHint')}
              </p>

              {filter === 'attention' && attentionCount === 0 ? (
                <p className="text-xs text-redlog-text-faint py-3">{t('plugins.allHandled')}</p>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-redlog-text-faint py-3">{t('plugins.noSearchResults')}</p>
              ) : (
                <div className="space-y-2">
                  {filtered.map((p) => (
                    <PluginRow key={p.id} p={p} vm={vms.get(p.id)!} t={t} description={descriptionOf(p, t)} onSelect={() => openDetail(p.id)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )

  return (
    <FieldGroup title={t('settings.plugins')}>
      <div ref={rootRef}>
        {/* Enabling and disabling are global whichever view they are pressed in. */}
        <p data-testid="plugins-global-note" className="text-xs text-redlog-text-faint mb-2">{t('plugins.globalNote', { page: t('settings.pageCaptureControl') })}</p>
        {detail ?? list}
      </div>

      {/* trust consent dialog for red-tier code plugins */}
      {confirmGrant && (
        <Modal
          open alert dismissOnBackdrop={false}
          onClose={() => setConfirmGrant(null)}
          label={consentTitle}
          testId="plugin-consent-dialog"
          panelClassName="bg-redlog-surface border border-red-900/50 rounded-lg p-4 max-w-md mx-4"
        >
          <h3 className="text-sm font-semibold text-red-400 mb-1">{consentTitle}</h3>
          <p className="text-xs text-redlog-text-dim mb-2">{consentBody}</p>
          {consent.code && (
            <>
              <div className="bg-redlog-bg border border-redlog-border rounded p-2 mb-2">
                <p className="text-xs text-redlog-text-dim mb-1">{t('plugins.capabilities')}:</p>
                <ul className="text-xs text-amber-400 space-y-0.5">
                  {confirmGrant.capabilities.length === 0 && <li className="text-redlog-text-dim">&mdash;</li>}
                  {confirmGrant.capabilities.map((c) => <li key={c}>&bull; {c}</li>)}
                </ul>
              </div>
              <p className="text-xs text-redlog-text-dim mb-3">{t('plugins.consentWarn')}</p>
            </>
          )}
          {consent.profiles.length > 0 && (
            <>
              {consent.code && <p className="text-xs text-redlog-text-dim mb-1">{t('plugins.consentProfilesToo')}</p>}
              <ul className="bg-redlog-bg border border-redlog-border rounded p-2 mb-3 text-xs text-amber-400 space-y-0.5">
                {consent.profiles.map((profile, i) => (
                  <li key={i} className="break-words">
                    {t(PROFILE_LINE[profile.mode] ?? PROFILE_LINE.relayed, { name: profile.name, commands: profile.executables.join(', ') })}
                    <span className="text-redlog-text-dim"> — {profile.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {consent.installs.length > 0 && (
            <>
              {(consent.code || consent.profiles.length > 0) && <p className="text-xs text-redlog-text-dim mb-1">{t('plugins.consentInstallsToo')}</p>}
              <ul className="bg-redlog-bg border border-redlog-border rounded p-2 mb-3 text-xs text-amber-400 space-y-0.5">
                {consent.installs.map((hook, i) => (
                  <li key={i} className="break-words">
                    {hook.installMethod === 'claude-settings'
                      ? t('plugins.installClaude', { name: hook.name })
                      : t('plugins.installShell', { name: hook.name })}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setConfirmGrant(null)} className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover">
              {t('common.cancel')}
            </button>
            <button onClick={() => grant(confirmGrant)} className="px-3 py-1 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover">
              {consent.code ? t('plugins.grantRun') : t('plugins.grantApprove')}
            </button>
          </div>
        </Modal>
      )}
    </FieldGroup>
  )
}