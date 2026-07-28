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
const DEFAULT_ORDER = ['dashboard', 'timeline', 'screenshots', 'targets', 'scope', 'loot', 'marks']

function loadOrder(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as string[]
      if (Array.isArray(parsed) && parsed.length === DEFAULT_ORDER.length) return parsed
    }
  } catch {}
  return DEFAULT_ORDER
}

export default function Sidebar({ active, onNavigate }: SidebarProps): JSX.Element {
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [order, setOrder] = useState(loadOrder)
  const dragItem = useRef<string | null>(null)
  const dragOverItem = useRef<string | null>(null)
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
    timeline: { id: 'timeline', label: t('sidebar.timeline'), icon: '═' },
    screenshots: { id: 'screenshots', label: t('sidebar.screens'), icon: '◻' },
    targets: { id: 'targets', label: t('sidebar.targets'), icon: '⊕' },
    scope: { id: 'scope', label: t('sidebar.scope'), icon: '⊘', badge: scopeViolations, badgeColor: 'bg-red-500' },
    loot: { id: 'loot', label: t('sidebar.loot'), icon: '◆', badge: lootCount, badgeColor: 'bg-amber-500' },
    marks: { id: 'marks', label: t('sidebar.marks'), icon: '⚑' }
  }

  const items = order.map((id) => itemMap[id]).filter(Boolean)

  const handleDragStart = useCallback((id: string) => {
    dragItem.current = id
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault()
    dragOverItem.current = id
  }, [])

  const handleDrop = useCallback(() => {
    if (!dragItem.current || !dragOverItem.current || dragItem.current === dragOverItem.current) return
    const newOrder = [...order]
    const fromIdx = newOrder.indexOf(dragItem.current)
    const toIdx = newOrder.indexOf(dragOverItem.current)
    if (fromIdx === -1 || toIdx === -1) return
    newOrder.splice(fromIdx, 1)
    newOrder.splice(toIdx, 0, dragItem.current)
    setOrder(newOrder)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newOrder))
    dragItem.current = null
    dragOverItem.current = null
  }, [order])

  return (
    <nav className="w-[140px] bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden">
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive = active === item.id
          return (
            <button
              key={item.id}
              draggable
              onDragStart={() => handleDragStart(item.id)}
              onDragOver={(e) => handleDragOver(e, item.id)}
              onDrop={handleDrop}
              onClick={() => onNavigate(item.id)}
              className={`w-full h-8 rounded-md flex items-center gap-2 px-2 transition-all duration-150 text-left relative ${
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
