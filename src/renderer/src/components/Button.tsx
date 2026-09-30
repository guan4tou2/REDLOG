import { forwardRef } from 'react'
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

// `border` is here, not on the levels: a level that sets only a border COLOUR
// paints nothing, which is how the quiet button stayed invisible until hover —
// what looked like an edge was the hover fill. Every level now has a 1px box
// and chooses what colour it is.
const BASE =
  'inline-flex items-center justify-center gap-1.5 h-[34px] px-4 rounded-lg text-sm font-medium border ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-redlog-bg disabled:opacity-40 disabled:cursor-not-allowed'

const LEVEL: Record<ButtonLevel, string> = {
  // The verb. At most one per screen (§4). Dark text, like every fill in this
  // palette — see the `on-*` tokens for why white fails on all of them.
  primary: 'border-transparent bg-redlog-accent text-redlog-on-accent hover:bg-redlog-accent-dim focus-visible:ring-redlog-accent/40',
  secondary: 'border-redlog-border bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover focus-visible:ring-redlog-text-dim/40',
  // Bordered, not bare. "Quiet" is about weight, not about whether the
  // operator can see where the control is: an unframed label gives no hit
  // area and no edge, so its target has to be guessed.
  quiet: 'border-redlog-border text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated focus-visible:ring-redlog-text-dim/40',
  // The only other fill in the system.
  danger: 'border-transparent bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover focus-visible:ring-redlog-danger/40'
}

/** The title-bar strip. It is 40px tall, so its controls are 28px rather than
 *  the app's 34px — the same density exception the terminal strip has. What it
 *  is not is four different sizes, which is what happened while every button
 *  in it was written where it was used: a 24px export trigger beside a 26px
 *  browser toggle beside two icon buttons of a third height. */
export const TITLEBAR_CONTROL =
  'inline-flex items-center justify-center gap-1 h-7 px-2.5 rounded-md border text-xs font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-redlog-bg disabled:opacity-50'

/** Same box, sized for a single icon. */
export const TITLEBAR_ICON = TITLEBAR_CONTROL.replace('px-2.5', 'w-7 px-0')

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  level?: ButtonLevel
  children: ReactNode
}

// forwardRef because a dialog focuses its confirm button, and a component that
// cannot be focused programmatically is one the shared geometry cannot reach.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { level = 'secondary', className = '', children, ...rest }, ref
) {
  return (
    <button ref={ref} className={`${BASE} ${LEVEL[level]} ${className}`} {...rest}>
      {children}
    </button>
  )
})
