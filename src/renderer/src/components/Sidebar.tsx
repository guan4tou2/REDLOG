import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Gauge, ChevronRight, Rows3, AlignLeft, Image, Crosshair,
  Ban, Gem, Flag, Search, ArrowLeftRight, Settings as SettingsIcon, type LucideIcon
} from 'lucide-react'
import { useI18n } from '../i18n'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
  /** §22: the views to render. Undefined shows everything — the shape a test
   *  harness or an older caller gets, and the safe direction. */
  visibleViews?: ReadonlySet<SidebarViewId>
}

interface NavItem {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  badgeColor?: string
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

export default function Sidebar({ active, onNavigate, visibleViews }: SidebarProps): JSX.Element {
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.scope.getViolationCount().then(setScopeViolations)
    const unsub = window.redlog.events.onNew(() => {
      window.redlog.loot.getCount().then(setLootCount)
      window.redlog.scope.getViolationCount().then(setScopeViolations)
    })
    return unsub
  }, [])

  // §4: 12% tint + same-colour text, the same vocabulary the badges elsewhere
  // use. Only danger fills, and a count is not danger — two solid blocks on
  // one sidebar is exactly the competition "one solid red per screen" exists
  // to prevent.
  const badge = (count: number, tone: string): JSX.Element | null =>
    count > 0 ? (
      <span className={`min-w-[18px] h-[18px] rounded-full ${tone} text-xs font-semibold tabular-nums flex items-center justify-center px-1`}>
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
    scope: { id: 'scope', label: t('sidebar.scope'), icon: Ban, badge: scopeViolations, badgeColor: 'bg-redlog-danger/12 text-redlog-danger' },
    loot: { id: 'loot', label: t('sidebar.loot'), icon: Gem, badge: lootCount, badgeColor: 'bg-amber-500/12 text-amber-400' },
    marks: { id: 'marks', label: t('sidebar.marks'), icon: Flag },
    search: { id: 'search', label: t('sidebar.search'), icon: Search },
    http_history: { id: 'http_history', label: t('sidebar.httpHistory'), icon: ArrowLeftRight }
  }

  // A hidden row is not-advertised, never unreachable: ⌘K lists every view and
  // its chord still works, which is what makes hiding safe rather than lossy.
  const items = DEFAULT_ORDER
    .filter((id) => visibleViews === undefined || visibleViews.has(id))
    .map((id) => itemMap[id])
    .filter(Boolean)

  const onItemClick = useCallback((id: string) => onNavigate(id), [onNavigate])

  return (
    <nav className="w-[186px] bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden">
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
              className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 px-2 transition-colors duration-150 text-left relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40 ${
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
              <span className={`text-xs leading-none truncate font-medium ${isActive ? 'text-redlog-accent' : ''}`}>
                {item.label}
              </span>
              <span className="ml-auto flex items-center gap-2 shrink-0">
                {'badge' in item && item.badge !== undefined && badge(item.badge, item.badgeColor || 'bg-redlog-elevated text-redlog-text-dim')}
              {/* §5.3: the number is printed, not hidden in a tooltip. It can
                  be, now that the order is fixed — while rows could be dragged
                  the number was a property of the current arrangement rather
                  than of the view, so showing it would have taught the wrong
                  thing. */}
                {chord !== null && (
                  <span
                    className={`text-xs font-mono tabular-nums ${isActive ? 'text-redlog-accent/70' : 'text-redlog-text-faint'}`}
                    aria-hidden
                  >
                    {chord}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto pt-3 border-t border-redlog-border/40">
        <button
          data-view-btn="settings"
          onClick={() => onNavigate('settings')}
          title={`${t('sidebar.config')} · ${isMac ? '⌘' : 'Ctrl+'}9`}
          aria-label={`${t('sidebar.config')} — ${isMac ? '⌘' : 'Ctrl+'}9`}
          aria-current={active === 'settings' ? 'page' : undefined}
          className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 px-2 transition-colors duration-150 text-left relative ${
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
          <span className={`text-xs leading-none truncate font-medium ${active === 'settings' ? 'text-redlog-accent' : ''}`}>{t('sidebar.config')}</span>
          <span
            className={`ml-auto shrink-0 text-xs font-mono tabular-nums ${active === 'settings' ? 'text-redlog-accent/70' : 'text-redlog-text-faint'}`}
            aria-hidden
          >9</span>
        </button>
      </div>
    </nav>
  )
}
