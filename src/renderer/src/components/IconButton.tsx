// An icon-only button that cannot be written without a name (UI/UX audit
// F16/F24). A bare "×" is read by a screen reader as "times" or nothing at
// all, and three such buttons had no label. `label` is required, used for
// both the accessible name and the tooltip, and the hit area is at least 24px.

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function IconButton({ label, children, className = '', ...rest }: {
  label: string
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title' | 'children'>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center min-w-6 min-h-6 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
