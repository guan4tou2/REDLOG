import { useState, useEffect, useRef, useCallback } from 'react'
import { useI18n } from '../i18n'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
}

interface NavItem {
  id: string
  label: string
  icon: string
  badge?: number
  badgeColor?: string
}

const STORAGE_KEY = 'redlog-sidebar-order'
const DEFAULT_ORDER = ['dashboard', 'terminal', 'timeline', 'screenshots', 'targets', 'scope', 'loot', 'marks']

function loadOrder(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as string[]
      const hasAllItems = DEFAULT_ORDER.every((id) => parsed.includes(id))
      if (Array.isArray(parsed) && hasAllItems) return parsed
    }
  } catch {}
  return DEFAULT_ORDER
}

// Vertical travel before a press counts as a reorder instead of a click.
const DRAG_THRESHOLD_PX = 6
const ITEM_STRIDE_PX = 34 // h-8 button + space-y-0.5 gap

export default function Sidebar({ active, onNavigate }: SidebarProps): JSX.Element {
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [order, setOrder] = useState(loadOrder)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // HTML5 `draggable` hands the browser control of the gesture, and any press
  // it decides was a drag never produces a click — so navigation would silently
  // fail. Own the gesture instead: a press is a click until it travels far
  // enough to be a reorder.
  const press = useRef<{ id: string; y: number; from: number } | null>(null)
  const didDrag = useRef(false)
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
      <span className={`ml-auto min-w-[18px] h-[18px] rounded-full ${color} text-[9px] text-white font-bold flex items-center justify-center px-1`}>
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  const itemMap: Record<string, NavItem> = {
    dashboard: { id: 'dashboard', label: t('sidebar.dashboard'), icon: '◉' },
    terminal: { id: 'terminal', label: t('sidebar.terminal'), icon: '▸' },
    timeline: { id: 'timeline', label: t('sidebar.timeline'), icon: '═' },
    screenshots: { id: 'screenshots', label: t('sidebar.screens'), icon: '◻' },
    targets: { id: 'targets', label: t('sidebar.targets'), icon: '⊕' },
    scope: { id: 'scope', label: t('sidebar.scope'), icon: '⊘', badge: scopeViolations, badgeColor: 'bg-red-500' },
    loot: { id: 'loot', label: t('sidebar.loot'), icon: '◆', badge: lootCount, badgeColor: 'bg-amber-500' },
    marks: { id: 'marks', label: t('sidebar.marks'), icon: '⚑' }
  }

  const items = order.map((id) => itemMap[id]).filter(Boolean)

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    press.current = { id, y: e.clientY, from: order.indexOf(id) }
    didDrag.current = false
  }, [order])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = press.current
    if (!p) return
    const dy = e.clientY - p.y
    if (!didDrag.current && Math.abs(dy) < DRAG_THRESHOLD_PX) return

    if (!didDrag.current) {
      didDrag.current = true
      setDraggingId(p.id)
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    const target = Math.max(0, Math.min(order.length - 1, p.from + Math.round(dy / ITEM_STRIDE_PX)))
    const current = order.indexOf(p.id)
    if (target === current) return
    const next = [...order]
    next.splice(current, 1)
    next.splice(target, 0, p.id)
    setOrder(next)
  }, [order])

  const onPointerUp = useCallback(() => {
    if (didDrag.current) localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
    press.current = null
    setDraggingId(null)
  }, [order])

  const onItemClick = useCallback((id: string) => {
    // A press that turned into a reorder should not also navigate.
    if (didDrag.current) {
      didDrag.current = false
      return
    }
    onNavigate(id)
  }, [onNavigate])

  return (
    <nav className="w-[140px] bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden">
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive = active === item.id
          return (
            <button
              key={item.id}
              onPointerDown={(e) => onPointerDown(e, item.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onClick={() => onItemClick(item.id)}
              title={t('sidebar.reorderHint')}
              className={`w-full h-8 rounded-md flex items-center gap-2 px-2 transition-all duration-150 text-left relative touch-none ${
                draggingId === item.id ? 'bg-white/[0.07] cursor-grabbing' : ''
              } ${
                isActive
                  ? 'text-red-400'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-red-500" />
              )}
              <span className={`text-[13px] leading-none w-4 text-center shrink-0 transition-colors ${isActive ? 'text-red-400' : ''}`}>
                {item.icon}
              </span>
              <span className={`text-[11px] leading-none truncate font-medium ${isActive ? 'text-red-400' : ''}`}>
                {item.label}
              </span>
              {'badge' in item && item.badge !== undefined && badge(item.badge, item.badgeColor || 'bg-zinc-500')}
            </button>
          )
        })}
      </div>

      <div className="mt-auto pt-3 border-t border-zinc-800/40">
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full h-8 rounded-md flex items-center gap-2 px-2 transition-all duration-150 text-left relative ${
            active === 'settings'
              ? 'text-red-400'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
          }`}
        >
          {active === 'settings' && (
            <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-red-500" />
          )}
          <span className={`text-[13px] leading-none w-4 text-center shrink-0 ${active === 'settings' ? 'text-red-400' : ''}`}>⚙</span>
          <span className={`text-[11px] leading-none truncate font-medium ${active === 'settings' ? 'text-red-400' : ''}`}>{t('sidebar.config')}</span>
        </button>
      </div>
    </nav>
  )
}
