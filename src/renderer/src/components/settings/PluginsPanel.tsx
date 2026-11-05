import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '../Button'
import { toast, toastUndo } from '../Toast'
import { FieldGroup } from './SettingsShared'
import { Modal } from '../Modal'
import { PluginSampleTester } from './PluginSampleTester'
import { CAPTURE_PACKS } from '../../../../core/capture-packs'
import { useContainerWidth } from '../../hooks/useContainerWidth'
import { matchesQuery } from '../../lib/textQuery'
import { pluginViewModel, needsAttention, type PluginView, type PluginViewModel } from '../../lib/pluginViewModel'
import PluginDetailPanel from './PluginDetailPanel'

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
const isHidden = (p: { id: string; status: string; officialAgent?: boolean }): boolean =>
  p.officialAgent === true || (OWNED_ELSEWHERE.has(p.id) && p.status !== 'disabled')

// The manifests describe these packs to whoever maintains them: spec
// numbers, doc paths, the identifiers the code uses, and the reason the
// thing is a manifest at all. None of that is what the operator standing on
// this page is asking, which is "what does this put in my record, and can I
// turn it off" -- and all of it was in English inside a Chinese interface.
// Bundled packs get a translated line each; a user's plugin still speaks for
// itself through its own manifest.

function PluginRow({ p, vm, t, busy, selected, onToggle, onReview, onRevoke, onSelect }: {
  p: PluginView; vm: PluginViewModel; t: T; busy: boolean; selected: boolean
  onToggle: (nextEnabled: boolean) => void; onReview: () => void; onRevoke: () => void; onSelect: () => void
}): JSX.Element {
  const privileged = p.tier === 'privileged'
  const needsConsent = vm.trust.needsConsent
  const cannotRevoke = vm.trust.cannotBeTrusted
  const issue = vm.issues[0]
  return (
    <div
      onClick={onSelect}
      className={`rounded border ${selected ? 'border-redlog-accent/60' : 'border-redlog-border'} bg-redlog-surface/50 cursor-pointer`}
    >
      <div className="flex items-start justify-between p-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-redlog-text">{p.name}</span>
            <span className="text-xs text-redlog-text-dim">v{p.version}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{t(`plugins.status.${p.status}`)}</span>
            {privileged && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-950/60 text-red-300">
                {t('plugins.tier.privileged')}
              </span>
            )}
          </div>
          {issue && <p data-testid={`plugin-issue-${p.id}`} className="text-xs text-amber-400 mt-0.5">{t(issue.labelKey)}</p>}
          <p className="text-xs text-redlog-text-dim mt-0.5 flex gap-2 items-center">
            <span className="break-words">{descriptionOf(p, t)}</span>
            <Button level="quiet" type="button" data-testid={`plugin-details-${p.id}`} onClick={(e) => { e.stopPropagation(); onSelect() }} className="shrink-0 underline">{t('plugins.details')}</Button>
          </p>
        </div>
        <div className="ml-3 shrink-0 flex flex-col gap-1 items-end" onClick={(e) => e.stopPropagation()}>
          {selected && <span className="text-xs text-redlog-text-faint">{t('plugins.managingHere')}</span>}
          {!selected && p.status !== 'error' && !needsConsent && (
            <button disabled={busy} onClick={() => onToggle(p.status === 'disabled')}
              className={`px-3 py-1 text-xs rounded ${p.status === 'disabled' ? 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'}`}>
              {busy ? '...' : p.status === 'disabled' ? t('plugins.enable') : t('plugins.disable')}
            </button>
          )}
          {!selected && needsConsent && !cannotRevoke && (
            <button disabled={busy} onClick={onReview}
              className="px-3 py-1 text-xs rounded bg-amber-600/80 text-redlog-on-warn hover:bg-amber-600">
              {t('plugins.review')}
            </button>
          )}
          {!selected && (privileged || p.needsApproval) && p.status === 'active' && (
            <button onClick={onRevoke} disabled={busy}
              className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400">
              {t('plugins.revoke')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function descriptionOf(p: PluginView, t: T): string {
  if (p.source !== 'bundled') return p.description
  const key = `plugins.builtin.${p.id}`
  const line = t(key)
  return line === key ? p.description : line
}

export default function PluginsPanel({ t }: { t: T }): JSX.Element {
  const describe = (p: PluginView): string => descriptionOf(p, t)

  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmGrant, setConfirmGrant] = useState<PluginView | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Every answer from main carries the whole list. Only the newest request may
  // replace what is on screen, so a slow reload cannot undo a later disable.
  const newest = useRef(0)

  const api = (window.redlog as unknown as { plugins: {
    list: () => Promise<PluginView[]>
    reload: () => Promise<PluginView[]>
    openFolder: () => Promise<string>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginView[]>
    grant: (id: string) => Promise<{ ok: boolean; error?: string; profilesError?: string; plugins: PluginView[] }>
    revoke: (id: string) => Promise<PluginView[]>
  } }).plugins

  const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  // A list that failed to load is not an empty list: the first says "try
  // again", the second says "there is nothing here".
  const load = async (): Promise<void> => {
    const mine = ++newest.current
    setLoading(true); setLoadError(null)
    try {
      const next = await api.list()
      if (mine === newest.current) setPlugins(next)
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
  const filtered = useMemo(() => shown.filter((p) => {
    const vm = vms.get(p.id)
    if (!vm) return false
    if (attentionOnly && !needsAttention(p)) return false
    return matchesQuery(vm.searchText, query)
  }), [shown, vms, attentionOnly, query])

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

  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const narrow = containerWidth !== null && containerWidth < 720
  const selected = vms.get(selectedId ?? '') ? plugins.find((p) => p.id === selectedId) : undefined
  const selectedVm = selected ? vms.get(selected.id) : undefined

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
      onBack={() => setSelectedId(null)} showBack={narrow}
    />
  ) : null

  return (
    <FieldGroup title={t('settings.plugins')}>
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

      <p data-testid="plugins-global-note" className="text-xs text-redlog-text-faint mb-2">{t('plugins.globalNote', { page: t('settings.pageCaptureControl') })}</p>

      {plugins[0]?.profilesError && (
        <div role="alert" data-testid="plugins-profiles-stale" className="text-xs mb-2 space-y-0.5">
          <p className="text-amber-300">{t('plugins.profilesStale')}</p>
          <p className="text-redlog-text-faint break-all">{plugins[0].profilesError}</p>
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
        <div ref={containerRef} className="min-w-0">
          {shown.length === 0 && <p className="text-xs text-redlog-text-faint py-3">{t('plugins.empty')}</p>}
          {shown.length > 0 && (
            <div className="mb-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search" data-testid="plugin-search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('plugins.searchPlaceholder')} aria-label={t('plugins.search')}
                  className="flex-1 min-w-0 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text focus:outline-none focus:border-red-500"
                />
                <label className="flex items-center gap-1.5 text-xs text-redlog-text-dim shrink-0">
                  <input type="checkbox" data-testid="plugin-attention-toggle" checked={attentionOnly}
                    onChange={(e) => setAttentionOnly(e.target.checked)} />
                  <span>{t('plugins.filterAttention')} ({attentionCount})</span>
                </label>
              </div>

              {attentionOnly && attentionCount === 0 ? (
                <p className="text-xs text-redlog-text-faint py-3">{t('plugins.allHandled')}</p>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-redlog-text-faint py-3">{t('plugins.noSearchResults')}</p>
              ) : narrow && selected !== undefined ? (
                detail
              ) : (
                <div className={narrow ? 'space-y-0' : 'flex gap-4'}>
                  <div className="min-w-0 flex-1 space-y-2">
                    {filtered.map((p) => {
                      const vm = vms.get(p.id)!
                      return (
                        <PluginRow key={p.id} p={p} vm={vm} t={t} busy={busy === p.id} selected={selectedId === p.id}
                          onToggle={(enabled) => void toggle(p, enabled)} onReview={() => setConfirmGrant(p)}
                          onRevoke={() => void revoke(p)} onSelect={() => setSelectedId(p.id)} />
                      )
                    })}
                  </div>
                  {!narrow && detail && <div className="w-1/2 max-w-md min-w-0 border-l border-redlog-border pl-4">{detail}</div>}
                  {!narrow && !detail && <p className="w-1/2 max-w-md min-w-0 border-l border-redlog-border pl-4 text-xs text-redlog-text-faint self-start">{t('plugins.selectHint')}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <PluginSampleTester t={t} />

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