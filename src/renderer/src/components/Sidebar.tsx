import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Gauge, ChevronRight, Rows3, AlignLeft, Image, Crosshair,
  Ban, Gem, Flag, Settings as SettingsIcon, type LucideIcon
} from 'lucide-react'
import { useI18n } from '../i18n'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
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

// Shared with App.tsx's ⌘1..9 shortcut handler so the two orders can't
// drift. See src/renderer/src/lib/sidebarOrder.ts.
import { DEFAULT_ORDER } from '../lib/sidebarOrder'

// Aliased so existing call sites don't need to change; the persistence lives
// in the shared module now so App.tsx's ⌘1..9 handler sees the same order.

// Vertical travel before a press counts as a reorder instead of a click. Kept
// comfortably above the few px a normal click/tap drifts on a trackpad — a
// smaller value reclassified ordinary clicks as drags and swallowed the first
// navigation (the "first click does nothing" bug).
const DRAG_THRESHOLD_PX = 12
const ITEM_STRIDE_PX = 34 // h-8 button + space-y-0.5 gap
const isMac = (window as { redlog?: { platform?: string } }).redlog?.platform !== 'win32'

export default function Sidebar({ active, onNavigate }: SidebarProps): JSX.Element {
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

  const badge = (count: number, color: string): JSX.Element | null =>
    count > 0 ? (
      <span className={`ml-auto min-w-[18px] h-[18px] rounded-full ${color} text-xs text-white font-bold flex items-center justify-center px-1`}>
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
    scope: { id: 'scope', label: t('sidebar.scope'), icon: Ban, badge: scopeViolations, badgeColor: 'bg-redlog-danger' },
    loot: { id: 'loot', label: t('sidebar.loot'), icon: Gem, badge: lootCount, badgeColor: 'bg-amber-500' },
    marks: { id: 'marks', label: t('sidebar.marks'), icon: Flag }
  }

  const items = DEFAULT_ORDER.map((id) => itemMap[id]).filter(Boolean)

  const onItemClick = useCallback((id: string) => onNavigate(id), [onNavigate])

  return (
    <nav className="w-[140px] bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden">
      <div className="space-y-0.5">
        {items.map((item, index) => {
          const isActive = active === item.id
          return (
            <button
              key={item.id}
              // Stable hook for e2e — see e2e/helpers.ts openView().
              data-view-btn={item.id}
              onClick={() => onItemClick(item.id)}
              title={`${item.label} · ${isMac ? '⌘' : 'Ctrl+'}${index + 1}`}
              aria-label={`${item.label} — ${isMac ? '⌘' : 'Ctrl+'}${index + 1}`}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 px-2 transition-colors duration-150 text-left relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 ${
                isActive
                  ? 'text-red-400'
                  : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-red-500" />
              )}
              <item.icon
                size={NAV_ICON_SIZE}
                strokeWidth={NAV_ICON_STROKE}
                aria-hidden
                className={`shrink-0 transition-colors ${isActive ? 'text-red-400' : ''}`}
              />
              <span className={`text-xs leading-none truncate font-medium ${isActive ? 'text-red-400' : ''}`}>
                {item.label}
              </span>
              {'badge' in item && item.badge !== undefined && badge(item.badge, item.badgeColor || 'bg-redlog-text-dim')}
              {/* §5.3: the number is printed, not hidden in a tooltip. It can
                  be, now that the order is fixed — while rows could be dragged
                  the number was a property of the current arrangement rather
                  than of the view, so showing it would have taught the wrong
                  thing. */}
              <span
                className={`ml-auto shrink-0 text-xs font-mono tabular-nums ${isActive ? 'text-red-400/70' : 'text-redlog-text-faint'}`}
                aria-hidden
              >
                {index + 1}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto pt-3 border-t border-redlog-border/40">
        <button
          data-view-btn="settings"
          onClick={() => onNavigate('settings')}
          className={`w-full h-[var(--row-h)] rounded-md flex items-center gap-2 px-2 transition-colors duration-150 text-left relative ${
            active === 'settings'
              ? 'text-red-400'
              : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
          }`}
        >
          {active === 'settings' && (
            <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-red-500" />
          )}
          <SettingsIcon
            size={NAV_ICON_SIZE}
            strokeWidth={NAV_ICON_STROKE}
            aria-hidden
            className={`shrink-0 ${active === 'settings' ? 'text-red-400' : ''}`}
          />
          <span className={`text-xs leading-none truncate font-medium ${active === 'settings' ? 'text-red-400' : ''}`}>{t('sidebar.config')}</span>
          <span
            className={`ml-auto shrink-0 text-xs font-mono tabular-nums ${active === 'settings' ? 'text-red-400/70' : 'text-redlog-text-faint'}`}
            aria-hidden
          >9</span>
        </button>
      </div>
    </nav>
  )
}
