interface SidebarProps {
  active: string
  onNavigate: (view: string) => void
}

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
      { id: 'scope', label: 'Scope', icon: '⊘' },
      { id: 'loot', label: 'Loot', icon: '◆' }
    ]
  },
  {
    label: 'OUTPUT',
    items: [
      { id: 'export', label: 'Export', icon: '↗' }
    ]
  }
]

export default function Sidebar({ active, onNavigate }: SidebarProps): JSX.Element {
  return (
    <div className="w-[52px] bg-redlog-bg border-r border-redlog-border flex flex-col items-center py-2 shrink-0 select-none">
      {/* Dashboard home */}
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

      <div className="w-8 border-t border-zinc-800 mb-1" />

      {groups.map((group) => (
        <div key={group.label} className="w-full flex flex-col items-center mb-1">
          <span className="text-[8px] text-zinc-600 font-semibold tracking-[0.12em] mb-0.5">{group.label}</span>
          {group.items.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              className={`w-10 h-8 rounded flex flex-col items-center justify-center gap-0 transition-colors ${
                active === item.id
                  ? 'bg-red-500/20 text-red-400'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              <span className="text-sm leading-none">{item.icon}</span>
              <span className="text-[7px] leading-none mt-0.5">{item.label}</span>
            </button>
          ))}
        </div>
      ))}

      {/* Settings at bottom */}
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
