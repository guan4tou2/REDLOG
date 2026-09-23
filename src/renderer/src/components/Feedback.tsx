// Shared loading indicator. Timeline, Loot, Scope and Screenshots (and before
// them Dashboard, Marks and Targets) each rolled their own — same visual, six
// implementations, and any polish had to be applied six times (audit findings
// P2 #43, #44). Matches the .animate-spin-slow ring used everywhere.
//
// The empty state that used to live beside it is `EmptyState.tsx`: the §5.4
// three-part version (what appears here, why it is empty, the next step).

export function LoadingSpinner({ label }: { label?: string } = {}): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center gap-3 text-redlog-text-dim text-xs" role="status" aria-live="polite">
      <div className="w-6 h-6 border-2 border-redlog-border border-t-red-500 rounded-full animate-spin-slow" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  )
}
