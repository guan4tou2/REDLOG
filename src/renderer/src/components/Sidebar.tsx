import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
}

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
      <span className={`ml-auto min-w-[18px] h-[18px] rounded-full ${color} text-[9px] text-white font-bold flex items-center justify-center px-1`}>
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  const items = [
    { id: 'dashboard', label: t('sidebar.dashboard'), icon: '◉' },
    { id: 'timeline', label: t('sidebar.timeline'), icon: '═' },
    { id: 'screenshots', label: t('sidebar.screens'), icon: '◻' },
    { id: 'targets', label: t('sidebar.targets'), icon: '⊕' },
    { id: 'scope', label: t('sidebar.scope'), icon: '⊘', badge: scopeViolations, badgeColor: 'bg-red-500' },
    { id: 'loot', label: t('sidebar.loot'), icon: '◆', badge: lootCount, badgeColor: 'bg-amber-500' },
    { id: 'marks', label: t('sidebar.marks'), icon: '⚑' }
  ]

  return (
    <nav className="w-[140px] bg-redlog-bg border-r border-redlog-border flex flex-col py-3 px-2 shrink-0 select-none overflow-hidden">
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive = active === item.id
          return (
            <button
              key={item.id}
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
              {'badge' in item && badge(item.badge as number, item.badgeColor as string)}
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
