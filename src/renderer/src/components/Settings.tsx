import { Button, FIELD_FOCUS_RING } from './Button'
import { useState, useEffect, useRef, useCallback } from 'react'
import AboutPage from './settings/AboutPage'
import { useI18n } from '../i18n'
import { registerPendingSave } from '../lib/pendingSaves'
import { dismissToast, toast } from './Toast'
import type { ConfigState, HookInfo } from './settings/SettingsShared'
import { isWindows } from './settings/SettingsShared'
import WslPanel from './WslPanel'
import GeneralPage from './settings/GeneralPage'
import ProjectSettings from './settings/ProjectSettings'
import HudPage from './settings/HudPage'
import NetworkPage from './settings/NetworkPage'
import BrowserPage from './settings/BrowserPage'
import ScopePage from './settings/ScopePage'
import CaptureControlPage from './settings/CaptureControlPage'
import CapturePackGroup from './settings/CapturePackGroup'
import HooksPanel from './settings/HooksPanel'
import PluginsPanel from './settings/PluginsPanel'
import IntegrityPanel from './settings/IntegrityPanel'
import LootRulesGroup from './settings/LootRulesGroup'
import RetentionPage from './settings/RetentionPage'
import { searchSettings } from '../lib/settingsSearch'
import { PROSE_WIDTH } from '../lib/pageLayout'
import { applyConfigPatch, diffConfig, rebaseDraft, valueAtPath, type ConfigPatchOp, type ConfigSaveResult } from '../../../core/config-patch'

// Existing settings routes. A typo must fail typechecking, not open an empty pane.
export type SettingsPage =
  | 'hooks' | 'captureControl' | 'browser'
  | 'scope' | 'network' | 'loot' | 'retention' | 'integrity'
  | 'general' | 'hud' | 'plugins' | 'about'

type HomeBadge = 'local' | 'project' | 'perProject'
interface HomeRow { id: SettingsPage; label: string; badge?: HomeBadge; action?: 'manage' | 'view' | 'openScope' }

/** The settings home, as the Stitch prototype lays it out (#590): three
 *  blocks, each row a title, where it applies, one line on what it holds, and
 *  one button. Pages the prototype has no row for (loot rules, integrity, the
 *  HUD) stay reachable as plain rows in the block they belong to. */
const HOME_SECTIONS: Array<{ key: 'capture' | 'project' | 'other'; rows: HomeRow[] }> = [
  { key: 'capture', rows: [
    { id: 'hooks', label: 'settings.pageHooks', badge: 'local' }, { id: 'browser', label: 'settings.pageBrowser', badge: 'project' }, { id: 'captureControl', label: 'settings.pageCaptureControl', badge: 'perProject' }
  ] },
  { key: 'project', rows: [
    { id: 'scope', label: 'settings.pageScope', badge: 'project', action: 'openScope' }, { id: 'network', label: 'settings.pageNetwork', badge: 'project' }, { id: 'loot', label: 'settings.pageLoot', badge: 'project' }
  ] },
  { key: 'other', rows: [
    { id: 'plugins', label: 'settings.pagePlugins' }, { id: 'retention', label: 'settings.pageRetention' }, { id: 'integrity', label: 'settings.pageIntegrity' }, { id: 'general', label: 'settings.pageGeneral' }, { id: 'hud', label: 'settings.pageHud' }, { id: 'about', label: 'settings.pageAbout', action: 'view' }
  ] }
]
/** One line on what each page holds. Literal keys, so the copy guard can see
 *  they are rendered. A page missing here shows its plain page name. */
const HOME_DESC: Partial<Record<SettingsPage, string>> = {
  hooks: 'settings.home.hooks.desc', browser: 'settings.home.browser.desc', captureControl: 'settings.home.captureControl.desc',
  network: 'settings.home.network.desc', plugins: 'settings.home.plugins.desc', retention: 'settings.home.retention.desc',
  general: 'settings.home.general.desc', about: 'settings.home.about.desc'
}
const HOME_WITH_COPY = new Set<SettingsPage>(['hooks', 'browser', 'captureControl', 'scope', 'network', 'plugins', 'retention', 'general', 'about'])

function SettingsHomeRow({ row, title, desc, status, onOpen, t }: {
  row: HomeRow; title: string; desc: string | null; status: string | null; onOpen: () => void; t: (k: string, v?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <button
      data-settings-page={row.id}
      onClick={onOpen}
      className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-white/[0.03] first:rounded-t-lg last:rounded-b-lg"
    >
      <span className="flex-1 min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-redlog-text">{title}</span>
          {row.badge && <span className="text-xs px-1.5 rounded border border-redlog-border-subtle text-redlog-text-dim">{t(`settings.home.badge.${row.badge}`)}</span>}
          {status && <span className="text-xs text-redlog-text-dim">{status}</span>}
        </span>
        {desc && <span className="block text-xs text-redlog-text-faint mt-0.5">{desc}</span>}
      </span>
      <span className="shrink-0 text-xs text-redlog-text-dim">{t(`settings.home.${row.action ?? 'manage'}`)} ›</span>
    </button>
  )
}

/** What Settings had not managed to save when it was left. Kept until a save
 *  of it succeeds, so leaving after a failed save and coming back shows the
 *  operator's edit again instead of the file. */
let unsavedDraft: { projectId: string | undefined; baseline: ConfigState; draft: ConfigState } | null = null

const stripBase = (op: ConfigPatchOp): ConfigPatchOp => {
  const { base: _base, baseAbsent: _absent, ...rest } = op
  return rest
}
/** An op that sets `path` to what `source` holds there. */
const pinTo = (source: unknown, path: ConfigPatchOp['path']): ConfigPatchOp => {
  const value = valueAtPath(source, path)
  return value === undefined ? { path, unset: true } : { path, value }
}

/** `request` is the page a link asked for (lib/navigation.ts). A new object
 *  per request, so asking again for the same page switches back to it. */
export default function Settings({ request = null }: { request?: { page: SettingsPage; scopeCandidate?: string; sourceId?: string } | null } = {}): JSX.Element {
  // Two copies of the config. `baseline` is the file as this page last saw
  // it; `config` (and `draft`, the same value readable outside a render) is
  // what the operator sees and edits. A save sends the difference, each field
  // with its baseline value, so main writes only what was changed here and
  // refuses — rather than overwrites — a field someone else changed meanwhile.
  const [config, setConfigState] = useState<ConfigState | null>(null)
  const baseline = useRef<ConfigState | null>(null)
  const draft = useRef<ConfigState | null>(null)
  const setConfig = useCallback((next: ConfigState): void => { draft.current = next; setConfigState(next) }, [])
  const adopt = (nextBaseline: ConfigState, nextDraft: ConfigState): void => {
    baseline.current = nextBaseline
    draft.current = nextDraft
    setConfigState(nextDraft)
  }
  const unsaved = (): ConfigPatchOp[] => (baseline.current && draft.current ? diffConfig(baseline.current, draft.current) : [])
  // The file as it was when the last save was refused for a conflict.
  const conflictAt = useRef<ConfigState | null>(null)
  // `null` is the home list. Settings is one column: a list of pages, and a
  // page opened from it with a way back (#590) — no second sidebar. A link that
  // names a page (`request`) lands on that page directly.
  const [tab, setTab] = useState<SettingsPage | null>(request?.page ?? null)
  // Spec 066: a link between an integration's plugin detail and its Capture
  // sources row. View-only; each side clears it once it has landed.
  const [pluginFocus, setPluginFocus] = useState<{ pluginId: string } | null>(null)
  // The plugin whose detail is open, in place of the plugin list. Held here so
  // the one back control above the page can say where it goes: to the list
  // from a detail, to Settings from the list.
  const [pluginDetail, setPluginDetail] = useState<string | null>(null)
  useEffect(() => { if (tab !== 'plugins') setPluginDetail(null) }, [tab])
  // The capture source (health id) the Capture sources page should land on:
  // from a dashboard warning (`request.sourceId`) or from a plugin's detail.
  const [captureFocus, setCaptureFocus] = useState<string | null>(request?.sourceId ?? null)
  useEffect(() => {
    if (!request) return
    setTab(request.page)
    setCaptureFocus(request.sourceId ?? null)
  }, [request])
  const [pageQuery, setPageQuery] = useState('')
  // The setting a search result points at: after its page renders, the text is
  // scrolled into view and marked briefly.
  const [findText, setFindText] = useState<{ key: string; text: string } | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = 0
  }, [tab])
  useEffect(() => {
    if (!findText || !pane.current) return
    const root = pane.current
    const locate = (): boolean => {
      const els = Array.from(root.querySelectorAll<HTMLElement>('h3, label, p, span, button'))
      const el = root.querySelector<HTMLElement>(`[data-settings-key="${findText.key}"]`)
        ?? els.find((e) => e.textContent?.includes(findText.text))
      if (!el) return false
      el.scrollIntoView?.({ block: 'center' })
      el.classList.add('ring-1', 'ring-redlog-accent', 'rounded')
      setTimeout(() => el.classList.remove('ring-1', 'ring-redlog-accent', 'rounded'), 1600)
      setFindText(null)
      return true
    }
    if (locate()) return
    // CA paths arrive after the page's status read, not during its first render.
    const observer = new MutationObserver(() => { if (locate()) observer.disconnect() })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [findText, tab])
  // Three states, not one flag. The bar used to show only "saved", so a write
  // in flight and a write that had failed both looked like nothing had
  // happened.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const { t } = useI18n()

  useEffect(() => {
    loadConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-save on every change so toggles apply live to the HUD / event pipeline
  // without a manual "save & apply" click. Debounced 350ms so text-input typing
  // coalesces into a single write instead of one per keystroke.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef(true)
  const inFlight = useRef<Promise<boolean> | null>(null)

  // A failed first read used to leave "Loading…" on screen for good: the
  // rejection was not handled, so nothing ever said the settings could not be
  // read or offered to try again (#223).
  const [loadFailed, setLoadFailed] = useState(false)
  const loadConfig = (): void => {
    setLoadFailed(false)
    window.redlog.config.get()
      .then((c) => {
        if (!live.current) return
        const fresh = c as ConfigState
        // An edit that never saved comes back onto the file as it is now, and
        // the autosave below tries it again.
        const kept = unsavedDraft && unsavedDraft.projectId === fresh.engagement?.id ? unsavedDraft : null
        unsavedDraft = null
        if (kept) { const r = rebaseDraft(kept.baseline, kept.draft, fresh); adopt(r.baseline, r.draft) }
        else adopt(fresh, fresh)
      })
      .catch(() => { if (live.current) setLoadFailed(true) })
  }

  const writeConfig = useCallback(async (): Promise<boolean> => {
    // One write at a time, each computed against the baseline the one before
    // it left.
    while (inFlight.current) await inFlight.current
    const base = baseline.current
    const sent = draft.current
    if (!base || !sent) return true
    const ops = diffConfig(base, sent)
    if (ops.length === 0) return true
    // The project this form was loaded from. `engagement.id` is the project
    // id — main treats it as the durable attribution boundary — so passing it
    // back lets main refuse a write aimed at a project the operator has since
    // switched away from, rather than applying a stale form to a new
    // engagement.
    const projectId = sent.engagement?.id
    const failureKey = `settings-save:${projectId}`
    if (live.current) setSaveState('saving')
    const write = (async (): Promise<boolean> => {
      let res: ConfigSaveResult
      try {
        res = await window.redlog.config.patch({ ops, ...(projectId ? { expectProjectId: projectId } : {}) })
      } catch {
        // Nothing is put back: the draft is still the draft until a save of
        // it succeeds.
        if (live.current) setSaveState('failed')
        toast(t('toast.saveFailed'), { type: 'error', key: failureKey })
        return false
      }
      window.dispatchEvent(new CustomEvent('redlog:config-saved', { detail: { source: 'settings' } }))
      if (!res.ok) {
        if (res.reason === 'conflict') {
          conflictAt.current = res.config as ConfigState
          toast(t('toast.saveConflict'), { type: 'error', key: failureKey })
        }
        if (live.current) setSaveState('failed')
        return false
      }
      dismissToast(failureKey)
      conflictAt.current = null
      // Main's file is the new baseline. Edits made while this write was on
      // its way are carried onto it; the ones that were not part of this
      // write keep their old baseline value, so a change someone else made to
      // them still reads as a conflict next time.
      const fresh = res.config as ConfigState
      const now = draft.current ?? sent
      const later = diffConfig(sent, now)
      const written = new Set(ops.map((op) => JSON.stringify(op.path)))
      const nextDraft = applyConfigPatch(fresh, later.map(stripBase)).config
      const nextBaseline = applyConfigPatch(fresh, later.filter((op) => !written.has(JSON.stringify(op.path))).map((op) => pinTo(base, op.path))).config
      if (live.current) {
        adopt(nextBaseline, nextDraft)
        setSaveState('saved')
        setTimeout(() => { if (live.current) setSaveState('idle') }, 1500)
      } else {
        baseline.current = nextBaseline
        draft.current = nextDraft
      }
      return true
    })().finally(() => { if (inFlight.current === write) inFlight.current = null })
    inFlight.current = write
    return write
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Retry. After a conflict it is the operator choosing their value: the
  // fields they changed are written over what is there now.
  const retry = (): void => {
    const disk = conflictAt.current
    if (disk && baseline.current && draft.current) {
      baseline.current = applyConfigPatch(baseline.current, unsaved().map((op) => pinTo(disk, op.path))).config
      conflictAt.current = null
    }
    void writeConfig()
  }

  useEffect(() => {
    if (!config) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    // A config read from main, or put back after a save, is not an edit.
    if (unsaved().length === 0) return
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void writeConfig() }, 350)
    return () => { if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Another page or view saved (Targets ▸ Add to scope, the capture card).
  // Take what it wrote, and keep this page's own unsaved edits on top.
  useEffect(() => {
    const onOutsideSave = (e: Event): void => {
      if ((e as CustomEvent<{ source?: string } | undefined>).detail?.source === 'settings') return
      window.redlog.config.get().then((raw) => {
        if (!live.current || !baseline.current || !draft.current) return
        const r = rebaseDraft(baseline.current, draft.current, raw as ConfigState)
        adopt(r.baseline, r.draft)
      }).catch(() => {})
    }
    window.addEventListener('redlog:config-saved', onOutsideSave)
    return () => window.removeEventListener('redlog:config-saved', onOutsideSave)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Settings is unmounted by navigating away — App renders it as
  // `view === 'settings' && <Settings/>`. A change made within 350ms of
  // leaving is flushed rather than dropped: the IPC completes in main whether
  // or not this component is still on screen. Until a save of it succeeds the
  // edit is also kept for the next time Settings opens.
  //
  // `live` is re-armed in setup: React.StrictMode mounts, cleans up and mounts
  // again in development, and a ref that only ever went false left the form
  // unable to show any save state after the first cleanup (#223).
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      const b = baseline.current
      const d = draft.current
      if (!b || !d || diffConfig(b, d).length === 0) return
      const kept = { projectId: d.engagement?.id, baseline: b, draft: d }
      unsavedDraft = kept
      void writeConfig().then((ok) => { if (ok && unsavedDraft === kept) unsavedDraft = null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Closing the project must not outrun this form (#223): App flushes every
  // registered save before it calls project.close(), and stops if one fails.
  useEffect(() => registerPendingSave(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    // A write already on its way is waited for; whatever it did not save is
    // still in the draft, and is tried once more here.
    if (inFlight.current) await inFlight.current
    return unsaved().length > 0 ? writeConfig() : true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  if (!config) {
    return loadFailed ? (
      <div data-testid="settings-load-failed" role="status" className="p-4 text-xs space-y-2">
        <p className="font-semibold text-redlog-text">{t('settings.loadFailedTitle')}</p>
        <p className="text-redlog-text-dim">{t('settings.loadFailedWhy')}</p>
        <Button size="compact" level="quiet"
          onClick={loadConfig}
        >{t('firstRun.recheck')}</Button>
      </div>
    ) : <div className="p-4 text-redlog-text-dim">{t('settings.loading')}</div>
  }

  const q = pageQuery.trim().toLowerCase()
  const pageLabel = new Map(HOME_SECTIONS.flatMap(section => section.rows.map(row => [row.id, t(row.label)] as const)))
  const hits = searchSettings(pageQuery, t, 30, window.redlog.platform)
  // Page-name matches and field matches share one result list.
  const matchedPages = HOME_SECTIONS.flatMap(section => section.rows)
    .filter(row => q && (pageLabel.get(row.id)?.toLowerCase().includes(q) ||
      (HOME_WITH_COPY.has(row.id) && t(`settings.home.${row.id}.title`).toLowerCase().includes(q))))
  for (const row of matchedPages) {
    if (!hits.some(hit => hit.page === row.id)) hits.push({ page: row.id, key: row.label, text: pageLabel.get(row.id)! })
  }

  return (
    <div className="flex flex-col h-full">
      {/* The right pane is a column: content scrolls, the save bar stays put. */}
      <div ref={pane} data-testid="settings-content" data-page={tab ?? 'home'} className="flex-1 min-w-0 min-h-0 overflow-y-auto p-pad space-y-4 [overflow-wrap:anywhere]">
        {tab === null ? (
          <div className="space-y-4" data-testid="settings-home">
            <header>
              <h1 className="text-lg font-semibold text-redlog-text">{t('sidebar.settings')}</h1>
              <p className={`text-xs text-redlog-text-dim ${PROSE_WIDTH}`}>{t('settings.home.subtitle')}</p>
            </header>
            <input
              value={pageQuery}
              onChange={(e) => setPageQuery(e.target.value)}
              placeholder={t('settings.searchSettings')}
              aria-label={t('settings.searchSettings')}
              className={`w-full px-3 py-2 bg-redlog-elevated border border-redlog-border rounded text-sm text-redlog-text placeholder-redlog-muted focus:border-redlog-accent/60 ${FIELD_FOCUS_RING}`}
            />
            {q !== '' && hits.length === 0 && !HOME_SECTIONS.some((sec) => sec.rows.some((r) => pageLabel.get(r.id)?.toLowerCase().includes(q) || t(`settings.home.${r.id}.title`).toLowerCase().includes(q))) && (
              <p className="py-4 text-xs text-redlog-text-faint text-center">
                {t('settings.noSettingMatches', { query: pageQuery })}
              </p>
            )}
            {!q && <nav aria-label={t('settings.categories')} className="space-y-5">
              {HOME_SECTIONS.map((sec) => {
                const rows = sec.rows
                if (rows.length === 0) return null
                return (
                  <section key={sec.key} aria-label={t(`settings.home.group.${sec.key}`)}>
                    <p className="pb-1 text-xs font-semibold text-redlog-muted tracking-[0.18em]">{t(`settings.home.group.${sec.key}`)}</p>
                    <div className="divide-y divide-redlog-border-subtle rounded-lg border border-redlog-border-subtle bg-redlog-surface">
                      {rows.map((row) => {
                        const own = HOME_WITH_COPY.has(row.id)
                        const status = row.id === 'scope'
                          ? t('settings.home.scope.status', { n: config.scope?.targets?.length ?? 0, m: config.scope?.excludeTargets?.length ?? 0 })
                          : null
                        return <SettingsHomeRow key={row.id} row={row} t={t}
                          title={own ? t(`settings.home.${row.id}.title`) : (pageLabel.get(row.id) ?? row.id)}
                          desc={own && HOME_DESC[row.id] ? t(HOME_DESC[row.id]!) : null}
                          status={status} onOpen={() => setTab(row.id)} />
                      })}
                    </div>
                  </section>
                )
              })}
            </nav>}
            {hits.length > 0 && (
              <section data-testid="settings-search-results">
                <p className="pb-1 text-xs font-semibold text-redlog-muted tracking-[0.18em]">{t('settings.searchResults')}</p>
                <div className="divide-y divide-redlog-border-subtle rounded-lg border border-redlog-border-subtle bg-redlog-surface">
                  {hits.map((h) => (
                    <button
                      key={`${h.page}:${h.text}`}
                      onClick={() => { setTab(h.page); setFindText({ key: h.key, text: h.text }) }}
                      className="w-full text-left px-3 py-2 text-xs text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]"
                    >
                      <span className="block truncate" title={h.text}>{h.text}</span>
                      <span className="block text-redlog-text-faint">{pageLabel.get(h.page)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 pb-1">
            <Button size="compact" level="quiet" data-testid="settings-back"
              onClick={() => { if (tab === 'plugins' && pluginDetail !== null) setPluginDetail(null); else setTab(null) }}>
              ← {tab === 'plugins' && pluginDetail !== null ? t('plugins.back') : t('nav.backTo', { view: t('sidebar.settings') })}
            </Button>
            <h2 className="text-sm font-semibold text-redlog-text">{pageLabel.get(tab)}</h2>
          </div>
        )}
        {tab === 'general' && <GeneralPage />}
        {tab === 'hud' && <HudPage t={t} />}
        {tab === 'browser' && <BrowserPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'network' && <NetworkPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'scope' && <><ScopePage candidate={request?.scopeCandidate} config={config} setConfig={setConfig} t={t} /><ProjectSettings config={config} setConfig={setConfig} /></>}
        {tab === 'hooks' && (
          <>
            <HooksPanel hooks={hooks} setHooks={setHooks} t={t} />
            {(isWindows || config.packs?.windowsOutput === true) && <>
              <CapturePackGroup pack="windowsOutput" title={t('settings.packWindowsOutput')} hint={t('settings.powershellTranscriptEnableHint')}
                config={config} setConfig={setConfig} t={t} onOpenPlugins={() => setTab('plugins')} />
            </>}
            {isWindows && <WslPanel t={t} />}
          </>
        )}
        {tab === 'captureControl' && <CaptureControlPage config={config} setConfig={setConfig} t={t} onOpenPlugins={() => setTab('plugins')}
          onOpenIntegration={(pluginId) => { setPluginFocus({ pluginId }); setTab('plugins') }}
          focusSource={captureFocus} onFocusHandled={() => setCaptureFocus(null)} />}
        {tab === 'loot' && <LootRulesGroup config={config} setConfig={setConfig} t={t} />}
        {tab === 'retention' && <RetentionPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'integrity' && <IntegrityPanel t={t} />}
        {tab === 'plugins' && <PluginsPanel t={t} config={config} focus={pluginFocus} onFocusHandled={() => setPluginFocus(null)}
          selectedId={pluginDetail} onSelect={setPluginDetail}
          onOpenCaptureSources={(agentKind) => { setCaptureFocus(`agent-${agentKind}`); setTab('captureControl') }} />}
        {tab === 'about' && <AboutPage t={t} />}
      </div>

      {/* Plugins are enabled, installed and trusted through their own calls,
          each answered at once; nothing on that page is a setting this form
          saves. The bar still appears there for a save already in flight. */}
      {(tab !== 'plugins' || saveState !== 'idle') && <div data-testid="settings-save-bar" className="px-4 py-2 border-t border-redlog-border shrink-0 flex flex-wrap items-center gap-x-3">
        {tab !== 'plugins' && <span className="text-redlog-text-faint text-xs">{t('settings.autoSaveHint')}</span>}
        {saveState !== 'idle' && (
          <span
            data-testid={`settings-save-${saveState}`}
            role="status"
            className={`text-xs ${saveState === 'failed' ? 'text-red-400' : saveState === 'saving' ? 'text-redlog-text-dim' : 'text-emerald-400'}`}
          >
            {t(`settings.save.${saveState}`)}
            {saveState === 'failed' && (
              <button
                onClick={retry}
                className="ml-2 underline hover:text-red-300"
              >{t('settings.save.retry')}</button>
            )}
          </span>
        )}
      </div>}
    </div>
  )
}
