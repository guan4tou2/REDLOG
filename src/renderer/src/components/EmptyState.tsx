import type { LucideIcon } from 'lucide-react'

// The empty state, in three parts (docs/UIUX-STANDARD.md §5.4).
//
// Every empty view in the app was a grey circle and two lines of grey text
// with no way out — "Screenshots will appear here when captured" tells an
// operator nothing they had not already worked out from the empty screen.
// §5.4 asks for three things, and the third is the one that was always
// missing:
//
//   what will appear here      so the view has a purpose before it has content
//   why there is nothing yet   the actual reason, not a restatement of "empty"
//   one button                 the next step, taken from here
//
// The `why` is the part worth writing carefully. "No screenshots yet" is the
// observation the operator just made themselves; "periodic capture is off and
// you have not taken one manually" is the reason, and it implies the fix.

export interface EmptyStateProps {
  icon: LucideIcon
  /** What will show up here, once there is something. */
  title: string
  /** Why there is nothing right now. The specific cause, not "it is empty". */
  reason: string
  /** The one next step. Omitted only when there genuinely isn't one. */
  action?: { label: string; onClick: () => void }
  /** A second, quieter route — usually "turn on the thing that fills this". */
  secondary?: { label: string; onClick: () => void }
}

export function EmptyState({
  icon: Icon, title, reason, action, secondary
}: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center text-center py-10 px-6 gap-3">
      <Icon size={24} strokeWidth={1.5} aria-hidden className="text-redlog-text-faint" />
      <p className="text-sm text-redlog-text">{title}</p>
      <p className="text-xs text-redlog-text-dim max-w-[46ch] leading-relaxed text-pretty">
        {reason}
      </p>
      {(action || secondary) && (
        <div className="flex items-center gap-3 mt-1">
          {action && (
            <button
              onClick={action.onClick}
              className="px-3 py-1.5 text-xs rounded border border-redlog-accent/60 text-redlog-accent hover:bg-redlog-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40 transition-colors"
            >
              {action.label}
            </button>
          )}
          {secondary && (
            <button
              onClick={secondary.onClick}
              className="text-xs text-redlog-text-dim hover:text-redlog-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim rounded"
            >
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
