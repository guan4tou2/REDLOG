import { useState, useEffect } from 'react'

interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
}

export default function Sidebar({ active, onNavigate }: SidebarProps): JSX.Element {
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)

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
      <span className={`absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full ${color} text-[8px] text-white font-bold flex items-center justify-center px-0.5`}>
        {count > 99 ? '99+' : count}
      </span>
    ) : null

  const groups = [
    {
      label: 'OPS',
      items: [
        { id: 'terminal', label: 'Terminal', icon: '▸' },
        { id: 'timeline', label: 'Timeline', icon: '═' },
        { id: 'screenshots', label: 'Screens', icon: '◻' }
      ]
    },
    {
      label: 'INTEL',
      items: [
        { id: 'targets', label: 'Targets', icon: '⊕' },
        { id: 'scope', label: 'Scope', icon: '⊘', badge: scopeViolations, badgeColor: 'bg-red-500' },
        { id: 'loot', label: 'Loot', icon: '◆', badge: lootCount, badgeColor: 'bg-yellow-500' },
        { id: 'marks', label: 'Marks', icon: '⚑' }
      ]
    }
  ]

  return (
    <div className="w-[52px] bg-redlog-bg border-r border-redlog-border flex flex-col items-center py-2 shrink-0 select-none">
      <button
        onClick={() => onNavigate('dashboard')}
        title="Dashboard"
        className={`w-10 h-8 rounded flex items-center justify-center text-sm mb-2 transition-colors ${
          active === 'dashboard'
            ? 'bg-red-500/20 text-red-400'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
        }`}
      >
        ◉
      </button>

      <button
        onClick={() => onNavigate('search')}
        title="Search (⌘/)"
        className={`w-10 h-7 rounded flex items-center justify-center text-sm mb-1 transition-colors ${
          active === 'search'
            ? 'bg-red-500/20 text-red-400'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
        }`}
      >
        ⌕
      </button>

      <div className="w-8 border-t border-zinc-800 mb-1" />

      {groups.map((group) => (
        <div key={group.label} className="w-full flex flex-col items-center mb-1">
          <span className="text-[8px] text-zinc-600 font-semibold tracking-[0.12em] mb-0.5">{group.label}</span>
          {group.items.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              className={`relative w-10 h-8 rounded flex flex-col items-center justify-center gap-0 transition-colors ${
                active === item.id
                  ? 'bg-red-500/20 text-red-400'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              <span className="text-sm leading-none">{item.icon}</span>
              <span className="text-[7px] leading-none mt-0.5">{item.label}</span>
              {'badge' in item && badge(item.badge as number, item.badgeColor as string)}
            </button>
          ))}
        </div>
      ))}

      <div className="mt-auto">
        <button
          onClick={() => onNavigate('settings')}
          title="Settings"
          className={`w-10 h-8 rounded flex flex-col items-center justify-center transition-colors ${
            active === 'settings'
              ? 'bg-red-500/20 text-red-400'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          <span className="text-sm leading-none">⚙</span>
          <span className="text-[7px] leading-none mt-0.5">Config</span>
        </button>
      </div>
    </div>
  )
}
