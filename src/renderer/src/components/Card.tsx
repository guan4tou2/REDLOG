import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

// The card (docs/UIUX-STANDARD.md §4).
//
// Cards used to carry a 2px colour bar across the top and, in some places,
// tint their whole background by status. Both are wrong for the same reason:
// they make the card itself the status indicator, so a screen of cards reads
// as a wall of colour with no hierarchy, and the operator cannot tell which
// one is actually shouting.
//
// The replacement puts the colour in a block on the left, wrapped around the
// icon. Danger fills it; everything else uses a 12% tint, matching the badge
// rule so one vocabulary covers both. The card's own background is always
// `surface` and never changes with state — status lives in one place on the
// card, not in the card.

export type CardTone = 'neutral' | 'safe' | 'warn' | 'danger' | 'info'

const TONE: Record<CardTone, { block: string; icon: string }> = {
  neutral: { block: 'bg-redlog-elevated', icon: 'text-redlog-text-dim' },
  safe: { block: 'bg-emerald-500/12', icon: 'text-emerald-400' },
  warn: { block: 'bg-amber-500/12', icon: 'text-amber-400' },
  info: { block: 'bg-cyan-500/12', icon: 'text-cyan-400' },
  // The one solid fill, and the one the standard allows once per screen.
  danger: { block: 'bg-redlog-danger', icon: 'text-white' }
}

export interface CardProps {
  icon: LucideIcon
  tone?: CardTone
  label: string
  children: ReactNode
  /** Turns the whole card into a button. */
  onClick?: () => void
  title?: string
}

export function Card({
  icon: Icon, tone = 'neutral', label, children, onClick, title
}: CardProps): JSX.Element {
  const t = TONE[tone]
  const body = (
    <>
      <span
        className={`flex items-center justify-center w-9 self-stretch shrink-0 rounded-l-lg ${t.block}`}
        aria-hidden
      >
        <Icon size={16} strokeWidth={1.5} className={t.icon} />
      </span>
      <div className="flex-1 min-w-0 p-[var(--pad)]">
        <p className="text-xs text-redlog-text-dim uppercase tracking-wider font-medium">{label}</p>
        {children}
      </div>
    </>
  )
  const shell = 'flex items-stretch bg-redlog-surface border border-redlog-border rounded-lg overflow-hidden text-left w-full'
  if (!onClick) return <div className={shell} title={title}>{body}</div>
  return (
    <button
      onClick={onClick}
      title={title}
      className={`${shell} transition-colors hover:border-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40`}
    >
      {body}
    </button>
  )
}
