import { Button } from './Button'
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

// Existing settings routes. A typo must fail typechecking, not open an empty pane.
export type SettingsPage =
  | 'hooks' | 'captureControl' | 'browser'
  | 'scope' | 'network' | 'loot' | 'retention' | 'integrity'
  | 'general' | 'hud' | 'plugins' | 'about'

/** `request` is the page a link asked for (lib/navigation.ts). A new object
 *  per request, so asking again for the same page switches back to it. */
export default function Settings({ request = null }: { request?: { page: SettingsPage; scopeCandidate?: string } | null } = {}): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  // `null` is the home list. Settings is one column: a list of pages, and a
  // page opened from it with a way back (#590) — no second sidebar. A link that
  // names a page (`request`) lands on that page directly.
  const [tab, setTab] = useState<SettingsPage | null>(request?.page ?? null)
  useEffect(() => { if (request) setTab(request.page) }, [request])
  // Spec 066: a link between an integration's plugin detail and its Capture
  // sources row. View-only; each side clears it once it has landed.
  const [pluginFocus, setPluginFocus] = useState<{ pluginId: string } | null>(null)
  const [captureFocus, setCaptureFocus] = useState<string | null>(null)
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
  // coalesces into a single write instead of one per keystroke. The initial
  // fetch is skipped by tracking whether we've seen a user-driven change.
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What the debounce is holding. Cleared once it has been handed to main.
  const pending = useRef<ConfigState | null>(null)
  const live = useRef(true)
  const inFlight = useRef<Promise<boolean> | null>(null)

  // A failed first read used to leave "Loading…" on screen for good: the
  // rejection was not handled, so nothing ever said the settings could not be
  // read or offered to try again (#223).
  const [loadFailed, setLoadFailed] = useState(false)
  const loadConfig = (): void => {
    setLoadFailed(false)
    window.redlog.config.get()
      .then((c) => { if (live.current) setConfig(c as ConfigState) })
      .catch(() => { if (live.current) setLoadFailed(true) })
  }

  const writeConfig = useCallback((next: ConfigState): Promise<boolean> => {
    pending.current = null
    if (live.current) setSaveState('saving')
    // A write that did not land is put back, so the next flush — closing the
    // project, leaving the page — tries it again instead of finding nothing
    // pending and reporting success.
    const keep = (): void => { if (pending.current === null) pending.current = next }
    // The project this form was loaded from. `engagement.id` is the project
    // id — main treats it as the durable attribution boundary — so passing it
    // back lets main refuse a write aimed at a project the operator has since
    // switched away from, rather than applying a stale form to a new
    // engagement.
    const failureKey = `settings-save:${next.engagement?.id}`
    const write = window.redlog.config.save(next, { expectProjectId: next.engagement?.id })
      .then((ok) => {
        window.dispatchEvent(new CustomEvent('redlog:config-saved'))
        if (ok === false) keep()
        else dismissToast(failureKey)
        if (live.current) {
          setSaveState(ok === false ? 'failed' : 'saved')
          if (ok !== false) setTimeout(() => { if (live.current) setSaveState('idle') }, 1500)
        }
        return ok !== false
      })
      .catch(() => {
        keep()
        if (live.current) setSaveState('failed')
        toast(t('toast.saveFailed'), { type: 'error', key: failureKey })
        return false
      })
      .finally(() => { if (inFlight.current === write) inFlight.current = null })
    inFlight.current = write
    return write
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!config) return
    if (!dirty.current) { dirty.current = true; return }  // ignore the setConfig from the initial fetch
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pending.current = config
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void writeConfig(config) }, 350)
    return () => { if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Settings is unmounted by navigating away — App renders it as
  // `view === 'settings' && <Settings/>`. The debounce's cleanup cancelled the
  // pending write, so a change made within 350ms of leaving the page was
  // dropped with nothing said. Flush it instead: the IPC completes in main
  // whether or not this component is still on screen.
  //
  // `live` is re-armed in setup: React.StrictMode mounts, cleans up and mounts
  // again in development, and a ref that only ever went false left the form
  // unable to show any save state after the first cleanup (#223).
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const unsaved = pending.current
      if (unsaved) void writeConfig(unsaved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Closing the project must not outrun this form (#223): App flushes every
  // registered save before it calls project.close(), and stops if one fails.
  useEffect(() => registerPendingSave(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    // A write already on its way is waited for; if it fails it puts its change
    // back, and that is tried once more here.
    if (inFlight.current) await inFlight.current
    const unsaved = pending.current
    return unsaved ? writeConfig(unsaved) : true
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

  // v0.9.10: left sidebar with grouped pages, ordered by the question the
  // operator is actually asking rather than by when each feature was added.
  const groups: Array<{ heading: string; pages: Array<{ id: SettingsPage; label: string }> }> = [
    {
      // One heading. #228 split these into "Core capture" and "Other capture
      // sources" to say that commands and HTTP(S) are what the product is
      // for — but a heading is a weak way to say it, and the order already
      // says it: the two that matter are the two at the top. What the split
      // did reliably was ask the operator to decide which of two capture
      // headings their question belonged under, every time they came here.
      heading: t('settings.groupCapture'),
      pages: [
        { id: 'hooks', label: t('settings.pageHooks') },
        // The browser and its HTTP capture proxy decide what ends up in the
        // record. They used to sit on Network, beside the VPN and
        // IP-exposure settings, which answer a different question entirely.
        { id: 'browser', label: t('settings.pageBrowser') },
        { id: 'captureControl', label: t('settings.pageCaptureControl') }
      ]
    },
    {
      heading: t('settings.groupScope'),
      pages: [
        { id: 'scope', label: t('settings.pageScope') },
        { id: 'network', label: t('settings.pageNetwork') }
      ]
    },
    {
      heading: t('settings.groupData'),
      pages: [
        // Spec 049: neither answers "what is being recorded". Loot detection
        // classifies what already was; retention decides what stops being
        // kept. Both sat under Capture sources, and retention — a deletion
        // policy — sat there as the last block of the page that held every
        // capture switch.
        { id: 'loot', label: t('settings.pageLoot') },
        { id: 'retention', label: t('settings.pageRetention') },
        // Chain verification is the other half of "can this record be handed
        // over": what was in bounds, and whether the record is intact. It used
        // to be the only page under its own heading, as Plugins was — a heading
        // over one entry groups nothing and costs a row of scanning.
        { id: 'integrity', label: t('settings.pageIntegrity') }
      ]
    },
    {
      heading: t('settings.groupApp'),
      pages: [
        { id: 'general', label: t('settings.pageGeneral') },
        { id: 'hud', label: t('settings.pageHud') }
      ]
    },
    {
      heading: t('settings.groupSystem'),
      pages: [
        { id: 'plugins', label: t('settings.pagePlugins') },
        { id: 'about', label: t('settings.pageAbout') }
      ]
    }
  ]

  const wideContent = tab !== null && ['hooks', 'plugins', 'scope', 'browser', 'captureControl', 'loot', 'integrity'].includes(tab)
  const q = pageQuery.trim().toLowerCase()
  const visible = groups
    .map((g) => ({ ...g, pages: g.pages.filter((pg) => !q || pg.label.toLowerCase().includes(q)) }))
    .filter((g) => g.pages.length > 0)
  const pageLabel = new Map(groups.flatMap((g) => g.pages.map((pg) => [pg.id, pg.label] as const)))
  const hits = searchSettings(pageQuery, t, 30, window.redlog.platform)

  return (
    <div className="flex flex-col h-full">
      {/* The right pane is a column: content scrolls, the save bar stays put. */}
      <div ref={pane} data-testid="settings-content" data-page={tab ?? 'home'} className={`flex-1 min-w-0 min-h-0 overflow-y-auto p-pad space-y-4 [overflow-wrap:anywhere] ${wideContent || tab === null ? '' : 'max-w-[900px]'}`}>
        {tab === null ? (
          <div className="max-w-[720px] mx-auto space-y-4" data-testid="settings-home">
            <input
              value={pageQuery}
              onChange={(e) => setPageQuery(e.target.value)}
              placeholder={t('settings.searchSettings')}
              aria-label={t('settings.searchSettings')}
              className="w-full px-3 py-2 bg-redlog-elevated border border-redlog-border rounded text-sm text-redlog-text placeholder-redlog-muted outline-none focus:border-redlog-accent/60"
            />
            {visible.length === 0 && hits.length === 0 && (
              <p className="py-4 text-xs text-redlog-text-faint text-center">
                {t('settings.noSettingMatches', { query: pageQuery })}
              </p>
            )}
            {/* Headings sit at the margin in the muted grey and never light
                up; a page is a row with a height that does. */}
            <nav aria-label={t('settings.categories')} className="space-y-4">
              {visible.map((g) => (
                <section key={g.heading} aria-label={g.heading}>
                  <p className="pb-1 text-xs font-semibold text-redlog-muted tracking-[0.18em]">{g.heading}</p>
                  <div className="divide-y divide-redlog-border-subtle rounded-lg border border-redlog-border-subtle bg-redlog-surface">
                    {g.pages.map((pg) => (
                      <button
                        key={pg.id}
                        data-settings-page={pg.id}
                        onClick={() => setTab(pg.id)}
                        className="w-full text-left px-3 h-[var(--row-h)] flex items-center justify-between text-sm text-redlog-text hover:bg-white/[0.03] first:rounded-t-lg last:rounded-b-lg"
                      >
                        <span>{pg.label}</span>
                        <span aria-hidden className="text-redlog-text-faint">›</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </nav>
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
            <Button size="compact" level="quiet" data-testid="settings-back" onClick={() => setTab(null)}>
              ← {t('nav.backTo', { view: t('sidebar.settings') })}
            </Button>
            <h2 className="text-sm font-semibold text-redlog-text">{pageLabel.get(tab)}</h2>
          </div>
        )}
        {tab === 'general' && <GeneralPage />}
        {tab === 'hud' && <HudPage config={config} setConfig={setConfig} t={t} />}
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
          focusAgentKind={captureFocus} onFocusHandled={() => setCaptureFocus(null)} />}
        {tab === 'loot' && <LootRulesGroup config={config} setConfig={setConfig} t={t} />}
        {tab === 'retention' && <RetentionPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'integrity' && <IntegrityPanel t={t} />}
        {tab === 'plugins' && <PluginsPanel t={t} config={config} focus={pluginFocus} onFocusHandled={() => setPluginFocus(null)}
          onOpenCaptureSources={(agentKind) => { setCaptureFocus(agentKind); setTab('captureControl') }} />}
        {tab === 'about' && <AboutPage t={t} />}
      </div>

      <div className="px-4 py-2 border-t border-redlog-border shrink-0 flex flex-wrap items-center gap-x-3">
        <span className="text-redlog-text-faint text-xs">{t('settings.autoSaveHint')}</span>
        {saveState !== 'idle' && (
          <span
            data-testid={`settings-save-${saveState}`}
            role="status"
            className={`text-xs ${saveState === 'failed' ? 'text-red-400' : saveState === 'saving' ? 'text-redlog-text-dim' : 'text-emerald-400'}`}
          >
            {t(`settings.save.${saveState}`)}
            {saveState === 'failed' && (
              <button
                onClick={() => { if (config) writeConfig(config) }}
                className="ml-2 underline hover:text-red-300"
              >{t('settings.save.retry')}</button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
