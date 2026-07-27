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
      <span className={`absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full ${color} text-[9px] text-white font-bold flex items-center justify-center px-0.5 shadow-lg`}>
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  const groups = [
    {
      label: t('sidebar.ops'),
      items: [
        { id: 'timeline', label: t('sidebar.timeline'), icon: '═' },
        { id: 'screenshots', label: t('sidebar.screens'), icon: '◻' }
      ]
    },
    {
      label: t('sidebar.intel'),
      items: [
        { id: 'targets', label: t('sidebar.targets'), icon: '⊕' },
        { id: 'scope', label: t('sidebar.scope'), icon: '⊘', badge: scopeViolations, badgeColor: 'bg-red-500' },
        { id: 'loot', label: t('sidebar.loot'), icon: '◆', badge: lootCount, badgeColor: 'bg-amber-500' },
        { id: 'marks', label: t('sidebar.marks'), icon: '⚑' }
      ]
    }
  ]

  const navBtn = (id: string, icon: string, label: string, extra?: JSX.Element): JSX.Element => (
    <button
      key={id}
      onClick={() => onNavigate(id)}
      title={label}
      className={`relative w-full h-10 rounded-md flex items-center gap-2.5 px-2.5 transition-all duration-150 ${
        active === id
          ? 'bg-red-500/10 text-red-400 border-l-2 border-red-500 shadow-glow-red-sm'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] border-l-2 border-transparent'
      }`}
    >
      <span className="text-base leading-none w-5 text-center shrink-0">{icon}</span>
      <span className="text-[11px] leading-none truncate opacity-0 group-hover/sb:opacity-100 transition-opacity duration-200 whitespace-nowrap">{label}</span>
      {extra}
    </button>
  )

  return (
    <div className="w-[52px] hover:w-[180px] group/sb bg-redlog-bg border-r border-redlog-border flex flex-col py-2.5 px-1.5 shrink-0 select-none transition-[width] duration-200 overflow-hidden">
      {navBtn('dashboard', '◉', t('sidebar.dashboard'))}
      {navBtn('search', '⌕', t('sidebar.search'))}

      <div className="w-full border-t border-zinc-800/40 my-2" />

      {groups.map((group) => (
        <div key={group.label} className="w-full flex flex-col mb-1.5">
          <span className="text-[9px] text-zinc-600 font-semibold tracking-[0.16em] uppercase mb-1 px-2.5 truncate opacity-0 group-hover/sb:opacity-100 transition-opacity duration-200">{group.label}</span>
          {group.items.map((item) => navBtn(
            item.id,
            item.icon,
            item.label,
            'badge' in item ? badge(item.badge as number, item.badgeColor as string) ?? undefined : undefined
          ))}
        </div>
      ))}

      <div className="mt-auto">
        <div className="w-full border-t border-zinc-800/40 mb-2" />
        {navBtn('settings', '⚙', t('sidebar.config'))}
      </div>
    </div>
  )
}
