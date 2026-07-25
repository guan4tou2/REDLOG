interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
  eventCount: number
}

const items = [
  { id: 'dashboard', label: 'Dashboard', icon: '◉' },
  { id: 'terminal', label: 'Terminal', icon: '▸' },
  { id: 'timeline', label: 'Timeline', icon: '═' },
  { id: 'screenshots', label: 'Screenshots', icon: '◻' },
  { id: 'targets', label: 'Targets', icon: '⊕' },
  { id: 'scope', label: 'Scope', icon: '⊘' },
  { id: 'loot', label: 'Loot', icon: '◆' },
  { id: 'export', label: 'Export', icon: '↗' }
]

export default function Sidebar({ active, onNavigate, eventCount }: SidebarProps): JSX.Element {
  return (
    <div className="w-14 bg-redlog-bg border-r border-redlog-border flex flex-col items-center py-3 gap-1 shrink-0">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onNavigate(item.id)}
          title={item.label}
          className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg transition-colors
            ${active === item.id
              ? 'bg-redlog-accent/20 text-redlog-accent'
              : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
            }`}
        >
          {item.icon}
        </button>
      ))}

      <div className="mt-auto">
        <div className="text-[10px] text-neutral-600 text-center leading-tight">
          <div className="text-neutral-400 font-mono">{eventCount}</div>
          events
        </div>
      </div>
    </div>
  )
}
