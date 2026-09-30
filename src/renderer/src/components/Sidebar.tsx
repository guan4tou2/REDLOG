import { useRef, useCallback, useState, useEffect } from 'react'
import { setShowAllPages } from '../lib/showAllPages'
import { SIDEBAR_COLLAPSED_EVENT, setSidebarCollapsed, storedSidebarCollapsed } from '../lib/sidebarCollapsed'
import {
  Gauge, ChevronRight, Rows3, AlignLeft, Image, Crosshair,
  Ban, Gem, Flag, Bookmark, Search, ArrowLeftRight, Settings as SettingsIcon, type LucideIcon, PanelLeft } from 'lucide-react'
import { useI18n } from '../i18n'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
  /** §22: the views to render. Undefined shows everything — the shape a test
   *  harness or an older caller gets, and the safe direction. */
  visibleViews?: ReadonlySet<SidebarViewId>
  /** Needed only to offer the per-project "show every page" opt-out. */
  projectId?: string
}

interface NavItem {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  badgeColor?: string
  badgeLabel?: string
}

// Lucide, 1.5px stroke, 16px (UIUX-STANDARD §4). These used to be the Unicode
// geometry `◉ ▸ ═ ☰ ◻ ⊕ ⊘ ◆ ⚑`, which is a glyph lookup rather than an icon:
// each one lands in a different fallback font per platform, so the row heights
// and optical weights disagreed between macOS and Windows, and a screen reader
// announced them by their Unicode names.
const NAV_ICON_SIZE = 16
const NAV_ICON_STROKE = 1.5

// Shared with App.tsx's ⌘1..9 shortcut handler so the printed number and the
// key that works can never disagree. See src/renderer/src/lib/sidebarOrder.ts.
import { DEFAULT_ORDER, shortcutNumberFor, type SidebarViewId } from '../lib/sidebarOrder'
import { isMac } from '../lib/platform'
import { useAppCounts } from '../lib/useAppCounts'

export default function Sidebar({ active, onNavigate, visibleViews, projectId }: SidebarProps): JSX.Element {
  const { lootCount, scopeViolations } = useAppCounts()
  const { t } = useI18n()

  // §4: 12% tint + same-colour text, the same vocabulary the badges elsewhere
  // use. Only danger fills, and a count is not danger — two solid blocks on
  // one sidebar is exactly the competition "one solid red per screen" exists
  // to prevent.
  // `label` names what the count counts, so a screen reader (and the tooltip)
  // says "1 violation" rather than a bare digit that could be a shortcut.
  const badge = (count: number, tone: string, label: string): JSX.Element | null =>
    count > 0 ? (
      <span
        className={`min-w-[18px] h-[18px] rounded-full ${tone} text-xs font-semibold tabular-nums flex items-center justify-center px-1`}
        title={label}
        aria-label={label}
      >
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  const itemMap: Record<string, NavItem> = {
    dashboard: { id: 'dashboard', label: t('sidebar.dashboard'), icon: Gauge },
    terminal: { id: 'terminal', label: t('sidebar.terminal'), icon: ChevronRight },
    timeline: { id: 'timeline', label: t('sidebar.timeline'), icon: Rows3 },
    transcript: { id: 'transcript', label: t('sidebar.transcript'), icon: AlignLeft },
    screenshots: { id: 'screenshots', label: t('sidebar.screens'), icon: Image },
    targets: { id: 'targets', label: t('sidebar.targets'), icon: Crosshair },
    scope: { id: 'scope', label: t('sidebar.scope'), icon: Ban, badge: scopeViolations, badgeColor: 'bg-redlog-danger/12 text-redlog-danger', badgeLabel: t('sidebar.violationsBadge', { count: scopeViolations }) },
    loot: { id: 'loot', label: t('sidebar.loot'), icon: Gem, badge: lootCount, badgeColor: 'bg-amber-500/12 text-amber-400', badgeLabel: t('sidebar.lootBadge', { count: lootCount }) },
    bookmarks: { id: 'bookmarks', label: t('sidebar.bookmarks'), icon: Bookmark },
    search: { id: 'search', label: t('sidebar.search'), icon: Search },
    http_history: { id: 'http_history', label: t('sidebar.httpHistory'), icon: ArrowLeftRight }
  }

  // A hidden row is not-advertised, never unreachable: ⌘K lists every view and
  // its chord still works, which is what makes hiding safe rather than lossy.
  const items = DEFAULT_ORDER
    .filter((id) => visibleViews === undefined || visibleViews.has(id))
    .map((id) => itemMap[id])
    .filter(Boolean)

  const hiddenCount = DEFAULT_ORDER.length - items.length

  // Collapsed, the sidebar is an icon rail. §3.5 allows icon-only here and
  // almost nowhere else: navigation is the highest-frequency thing in the app,
  // every row keeps its ⌘N chord, and the tooltip names it. The labels are the
  // default, because a rail has to be learned first.
  const [collapsed, setCollapsed] = useState(storedSidebarCollapsed)
  useEffect(() => {
    const onChange = (): void => setCollapsed(storedSidebarCollapsed())
    window.addEventListener(SIDEBAR_COLLAPSED_EVENT, onChange)
    return () => window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, onChange)
  }, [])

  const onItemClick = useCallback((id: string) => onNavigate(id), [onNavigate])

  return (
    <nav className={`${collapsed ? 'w-[56px]' : 'w-[186px]'} bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden transition-[width] duration-150`}>
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive = active === item.id
          // The view's own number, never its position in what happens to be
          // rendered — a hidden row must not renumber the ones below it.
          const chord = shortcutNumberFor(item.id as SidebarViewId)
          const chordLabel = chord ? ` · ${isMac ? '⌘' : 'Ctrl+'}${chord}` : ''
          return (
            <button
              key={item.id}
              // Stable hook for e2e — see e2e/helpers.ts openView().
              data-view-btn={item.id}
              onClick={() => onItemClick(item.id)}
              title={`${item.label}${chordLabel}`}
              aria-label={`${item.label}${chordLabel.replace(' · ', ' — ')}`}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 transition-colors duration-150 text-left relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40 ${collapsed ? 'justify-center px-0' : 'px-2'} ${
                isActive
                  ? 'text-redlog-accent'
                  : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-redlog-accent" />
              )}
              <item.icon
                size={NAV_ICON_SIZE}
                strokeWidth={NAV_ICON_STROKE}
                aria-hidden
                className={`shrink-0 transition-colors ${isActive ? 'text-redlog-accent' : ''}`}
              />
              {!collapsed && (
                <span className={`text-xs leading-none truncate font-medium ${isActive ? 'text-redlog-accent' : ''}`}>
                  {item.label}
                </span>
              )}
              <span className={`ml-auto flex items-center gap-2 shrink-0 ${collapsed ? 'hidden' : ''}`}>
                {'badge' in item && item.badge !== undefined && badge(item.badge, item.badgeColor || 'bg-redlog-elevated text-redlog-text-dim', item.badgeLabel ?? String(item.badge))}
              {/* §5.3: the number is printed, not hidden in a tooltip. It can
                  be, now that the order is fixed — while rows could be dragged
                  the number was a property of the current arrangement rather
                  than of the view, so showing it would have taught the wrong
                  thing.

                  The column is reserved even on a row with no chord. Without
                  the placeholder, a count badge on such a row slid into the
                  number column, and a red "1" beside 範圍 read as ⌘1. */}
                <span
                  className={`inline-block w-3 text-right text-xs font-mono tabular-nums ${isActive ? 'text-redlog-accent/70' : 'text-redlog-text-faint'}`}
                  aria-hidden
                >
                  {chord ?? ''}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* §22 hides a noun until its data exists, and the rule is right — but
          it is invisible, so a correct four-row sidebar reads as one that lost
          something. Saying so costs a line, and puts the opt-out where the
          absence is noticed rather than three pages into Settings. */}
      {hiddenCount > 0 && !collapsed && (
        <p className="mt-auto pt-3 px-2 text-xs text-redlog-text-faint leading-relaxed">
          {t('sidebar.hiddenHint', { count: hiddenCount })}{' '}
          <button
            data-testid="sidebar-show-all"
            onClick={() => { if (projectId) setShowAllPages(projectId, true) }}
            className="underline hover:text-redlog-text"
          >{t('sidebar.showAll')}</button>
        </p>
      )}
      <div className={`${hiddenCount > 0 ? 'mt-3' : 'mt-auto'} pt-3 border-t border-redlog-border/40 space-y-0.5`}>
        <button
          data-testid="sidebar-collapse"
          onClick={() => setSidebarCollapsed(!collapsed)}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-expanded={!collapsed}
          className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 transition-colors duration-150 text-left text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03] ${collapsed ? 'justify-center px-0' : 'px-2'}`}
        >
          <PanelLeft size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} aria-hidden className="shrink-0" />
          {!collapsed && <span className="text-xs leading-none truncate font-medium">{t('sidebar.collapse')}</span>}
        </button>
        <button
          data-view-btn="settings"
          onClick={() => onNavigate('settings')}
          title={`${t('sidebar.config')} · ${isMac ? '⌘' : 'Ctrl+'}9`}
          aria-label={`${t('sidebar.config')} — ${isMac ? '⌘' : 'Ctrl+'}9`}
          aria-current={active === 'settings' ? 'page' : undefined}
          className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 transition-colors duration-150 text-left relative ${collapsed ? 'justify-center px-0' : 'px-2'} ${
            active === 'settings'
              ? 'text-redlog-accent'
              : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
          }`}
        >
          {active === 'settings' && (
            <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-redlog-accent" />
          )}
          <SettingsIcon
            size={NAV_ICON_SIZE}
            strokeWidth={NAV_ICON_STROKE}
            aria-hidden
            className={`shrink-0 ${active === 'settings' ? 'text-redlog-accent' : ''}`}
          />
          {!collapsed && (
            <span className={`text-xs leading-none truncate font-medium ${active === 'settings' ? 'text-redlog-accent' : ''}`}>{t('sidebar.config')}</span>
          )}
          <span
            className={`ml-auto shrink-0 text-xs font-mono tabular-nums ${collapsed ? 'hidden' : ''} ${active === 'settings' ? 'text-redlog-accent/70' : 'text-redlog-text-faint'}`}
            aria-hidden
          >9</span>
        </button>
      </div>
    </nav>
  )
}
