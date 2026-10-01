import type { ReactNode } from 'react'

// The one section label (docs/UIUX-STANDARD.md §2: 13px / 600 / tracking .14em).
//
// It was written out 39 times in twelve different spellings — three letter
// spacings, two greys, a font weight that came and went. Nobody chose any of
// that; each one was copied from whichever file was open. A label that names
// the group above a list is a component, not a habit.
//
// `uppercase` stays because it is correct for the Latin labels (STDOUT,
// HEADERS) and a no-op for Chinese. What it must never be is the *hierarchy*:
// a heading is told apart from the rows under it by structure — the rows are
// indented, have a row height, and light up under the pointer — because in
// Chinese `uppercase` draws nothing at all (§3.5).

export function SectionLabel({ children, className = '' }: {
  children: ReactNode
  /** Layout only — margins, flex, sticky. Never type or colour. */
  className?: string
}): JSX.Element {
  return (
    <p className={`text-xs font-semibold text-redlog-text-faint uppercase tracking-[0.14em] ${className}`}>
      {children}
    </p>
  )
}
