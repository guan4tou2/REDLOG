// Shared loading + empty-state components. Timeline, Loot, Scope, Screenshots
// (and prior to this Dashboard, Marks, Targets) each rolled their own — same
// visual, six different implementations, and any polish had to be applied six
// times (audit findings P2 #43, #44).
//
// LoadingSpinner: matches the .animate-spin-slow ring the app uses everywhere.
// EmptyState: icon + title + optional subtitle + optional call-to-action. All
// slots are optional so a single-line "no data yet" and a full featured empty
// screen use the same primitive.

export function LoadingSpinner({ label }: { label?: string } = {}): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center gap-3 text-redlog-text-dim text-xs" role="status" aria-live="polite">
      <div className="w-6 h-6 border-2 border-redlog-border border-t-red-500 rounded-full animate-spin-slow" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function EmptyState({ icon, title, subtitle, action }: {
  icon?: string
  title: string
  subtitle?: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6 py-10">
      {icon && <div className="text-3xl opacity-30 mb-1" aria-hidden="true">{icon}</div>}
      <p className="text-redlog-text-dim text-sm font-medium">{title}</p>
      {subtitle && <p className="text-redlog-text-faint text-xs max-w-md leading-relaxed">{subtitle}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 px-3 py-1.5 text-xs rounded bg-redlog-elevated hover:bg-redlog-elevated-hover text-redlog-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
