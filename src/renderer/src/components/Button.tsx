import type { ButtonHTMLAttributes, ReactNode } from 'react'

// The four button levels (docs/UIUX-STANDARD.md §4), in one place.
//
// §1 originally said brand red may only draw text or a hairline, and only
// danger red may fill. That drew the line in the wrong place: it made the
// strongest control on the screen the weakest-looking one, and "Install the
// shell hook" — the single way out of the dashboard's main question — cannot
// be carried by an outline button.
//
// The line that actually works is verb versus state. A filled #d75f63
// "Create project" does not read as a warning, because it is a verb you can
// press; a filled #ff4d4f "IP exposed" does not read as a button, because it
// is reporting a state. So brand red fills command buttons and nothing else,
// while danger red fills wherever it needs to.
//
// One hard constraint follows, and it is the case where two reds five
// luminance units apart really would be indistinguishable: never put a filled
// primary and a filled danger in the same action row. That situation is a
// destructive dialog, which only ever holds Cancel and the destructive verb —
// and with "at most one primary per screen" and "one danger red app-wide", it
// does not arise. `ConfirmDialog` is asserted against it in the tests.

export type ButtonLevel = 'primary' | 'secondary' | 'quiet' | 'danger'

const BASE =
  'inline-flex items-center justify-center gap-1.5 h-[34px] px-4 rounded-lg text-sm font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-redlog-bg disabled:opacity-40 disabled:cursor-not-allowed'

const LEVEL: Record<ButtonLevel, string> = {
  // The verb. At most one per screen (§4). Dark text, like every fill in this
  // palette — see the `on-*` tokens for why white fails on all of them.
  primary: 'bg-redlog-accent text-redlog-on-accent hover:bg-redlog-accent-dim focus-visible:ring-redlog-accent/40',
  secondary: 'bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover focus-visible:ring-redlog-text-dim/40',
  quiet: 'text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated focus-visible:ring-redlog-text-dim/40',
  // The only other fill in the system.
  danger: 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover focus-visible:ring-redlog-danger/40'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  level?: ButtonLevel
  children: ReactNode
}

export function Button({
  level = 'secondary', className = '', children, ...rest
}: ButtonProps): JSX.Element {
  return (
    <button className={`${BASE} ${LEVEL[level]} ${className}`} {...rest}>
      {children}
    </button>
  )
}
