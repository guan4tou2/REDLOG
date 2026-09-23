import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import type { ConfigState, HookInfo } from './settings/SettingsShared'
import { isWindows } from './settings/SettingsShared'
import WslPanel from './WslPanel'
import GeneralPage from './settings/GeneralPage'
import HudPage from './settings/HudPage'
import NetworkPage from './settings/NetworkPage'
import ScopePage from './settings/ScopePage'
import CaptureControlPage from './settings/CaptureControlPage'
import HooksPanel from './settings/HooksPanel'
import PluginsPanel from './settings/PluginsPanel'
import IntegrityPanel from './settings/IntegrityPanel'
import AgentsPanel, { HookWatchPathsPanel } from './settings/AgentsPanel'
import { searchSettings } from '../lib/settingsSearch'

// The thirteen pages §10 asks for. Declared as a union so a typo in a route
// is a compile error rather than a page that silently never renders.
export type SettingsPage =
  | 'hooks' | 'agents' | 'captureControl'
  | 'scope' | 'network'
  | 'integrity'
  | 'plugins'
  | 'general' | 'hud'

/** `request` is the page a link asked for (lib/navigation.ts). A new object
 *  per request, so asking again for the same page switches back to it. */
export default function Settings({ request = null }: { request?: { page: SettingsPage } | null } = {}): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<SettingsPage>(request?.page ?? 'hooks')
  useEffect(() => { if (request) setTab(request.page) }, [request])
  const [pageQuery, setPageQuery] = useState('')
  // The setting a search result points at: after its page renders, the text is
  // scrolled into view and marked briefly.
  const [findText, setFindText] = useState<string | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!findText || !pane.current) return
    const els = Array.from(pane.current.querySelectorAll<HTMLElement>('h3, label, p, span, button'))
    const el = els.find((e) => e.textContent?.includes(findText))
    setFindText(null)
    if (!el) return
    el.scrollIntoView?.({ block: 'center' })
    el.classList.add('ring-1', 'ring-redlog-accent', 'rounded')
    setTimeout(() => el.classList.remove('ring-1', 'ring-redlog-accent', 'rounded'), 1600)
  }, [findText, tab])
  const [saved, setSaved] = useState(false)
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [hookLoading, setHookLoading] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.config.get().then((c) => setConfig(c as ConfigState))
  }, [])

  // Auto-save on every change so toggles apply live to the HUD / event pipeline
  // without a manual "save & apply" click. Debounced 350ms so text-input typing
  // coalesces into a single write instead of one per keystroke. The initial
  // fetch is skipped by tracking whether we've seen a user-driven change.
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!config) return
    if (!dirty.current) { dirty.current = true; return }  // ignore the setConfig from the initial fetch
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.redlog.config.save(config).then(() => {
        window.dispatchEvent(new CustomEvent('redlog:config-saved'))
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }).catch(() => toast(t('toast.saveFailed'), 'error'))
    }, 350)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  if (!config) return <div className="p-4 text-redlog-text-dim">{t('settings.loading')}</div>

  // v0.9.10: left sidebar with grouped pages, ordered by the question the
  // operator is actually asking rather than by when each feature was added.
  const groups: Array<{ heading: string; pages: Array<{ id: SettingsPage; label: string }> }> = [
    {
      heading: t('settings.groupCapture'),
      pages: [
        { id: 'hooks', label: t('settings.pageHooks') },
        { id: 'agents', label: t('settings.pageAgents') },
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
      heading: t('settings.groupEvidence'),
      pages: [
        { id: 'integrity', label: t('settings.pageIntegrity') }
      ]
    },
    {
      heading: t('settings.groupCollab'),
      pages: [
        { id: 'plugins', label: t('settings.pagePlugins') }
      ]
    },
    {
      heading: t('settings.groupApp'),
      pages: [
        { id: 'general', label: t('settings.pageGeneral') },
        { id: 'hud', label: t('settings.pageHud') }
      ]
    }
  ]

  const q = pageQuery.trim().toLowerCase()
  const visible = groups
    .map((g) => ({ ...g, pages: g.pages.filter((pg) => !q || pg.label.toLowerCase().includes(q)) }))
    .filter((g) => g.pages.length > 0)
  const pageLabel = new Map(groups.flatMap((g) => g.pages.map((pg) => [pg.id, pg.label] as const)))
  const hits = searchSettings(pageQuery, t)

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('settings.categories')}
        className="w-[212px] shrink-0 border-r border-redlog-border flex flex-col overflow-hidden"
      >
        <div className="p-2 border-b border-redlog-border">
          <input
            value={pageQuery}
            onChange={(e) => setPageQuery(e.target.value)}
            placeholder={t('settings.searchSettings')}
            aria-label={t('settings.searchSettings')}
            className="w-full px-2 py-1.5 bg-redlog-elevated border border-redlog-border rounded text-xs text-redlog-text placeholder-redlog-muted outline-none focus:border-redlog-accent/60"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {visible.length === 0 && hits.length === 0 && (
            <p className="px-3 py-4 text-xs text-redlog-text-faint text-center">
              {t('settings.noSettingMatches', { query: pageQuery })}
            </p>
          )}
          {visible.map((g) => (
            <div key={g.heading} className="mb-2">
              <p className="px-3 pt-1 pb-1 text-xs font-semibold text-redlog-text-faint uppercase tracking-wider">
                {g.heading}
              </p>
              {g.pages.map((pg) => (
                <button
                  key={pg.id}
                  data-settings-page={pg.id}
                  onClick={() => setTab(pg.id)}
                  aria-current={tab === pg.id ? 'page' : undefined}
                  className={`w-full text-left px-3 h-[var(--row-h)] flex items-center text-xs rounded-md transition-colors ${
                    tab === pg.id
                      ? 'bg-redlog-elevated text-redlog-text'
                      : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
                  }`}
                >
                  {pg.label}
                </button>
              ))}
            </div>
          ))}
          {hits.length > 0 && (
            <div className="mb-2" data-testid="settings-search-results">
              <p className="px-3 pt-1 pb-1 text-xs font-semibold text-redlog-text-faint uppercase tracking-wider">
                {t('settings.searchResults')}
              </p>
              {hits.map((h) => (
                <button
                  key={`${h.page}:${h.text}`}
                  onClick={() => { setTab(h.page); setFindText(h.text) }}
                  className="w-full text-left px-3 py-1 text-xs rounded-md text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]"
                >
                  <span className="block truncate" title={h.text}>{h.text}</span>
                  <span className="block text-redlog-text-faint">{pageLabel.get(h.page)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {saved && (
          <p className="px-3 py-2 text-xs text-emerald-400 border-t border-redlog-border">
            {t('settings.saved')}
          </p>
        )}
      </nav>

      {/* The right pane is a column: content scrolls, the save bar stays put. */}
      <div className="flex-1 min-w-0 flex flex-col">
      <div ref={pane} className="flex-1 overflow-y-auto p-4 space-y-4 max-w-[900px]">
        {tab === 'general' && <GeneralPage config={config} setConfig={setConfig} />}
        {tab === 'hud' && <HudPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'network' && <NetworkPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'scope' && <ScopePage config={config} setConfig={setConfig} t={t} />}
        {tab === 'hooks' && (
          <>
            <HooksPanel hooks={hooks} setHooks={setHooks} hookLoading={hookLoading} setHookLoading={setHookLoading} t={t} />
            {isWindows && <WslPanel t={t} />}
            <HookWatchPathsPanel t={t} />
          </>
        )}
        {tab === 'agents' && <AgentsPanel t={t} config={config} setConfig={setConfig} />}
        {tab === 'captureControl' && <CaptureControlPage config={config} setConfig={setConfig} t={t} />}
        {tab === 'integrity' && <IntegrityPanel t={t} />}
        {tab === 'plugins' && <PluginsPanel t={t} />}
      </div>

      <div className="px-4 py-2 border-t border-redlog-border shrink-0 max-w-[900px]">
        <span className="text-redlog-text-faint text-xs">{t('settings.autoSaveHint')}</span>
      </div>
      </div>
    </div>
  )
}
