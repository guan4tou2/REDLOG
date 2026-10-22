import type { ReactNode } from 'react'

// One checkbox row, everywhere.
//
// The audit that produced this measured 38 checkboxes at 13x13 with a label
// row 20px tall — under WCAG 2.5.8's 24x24 floor, and under this app's own
// §3 rule that a hit area never drops below 32px even in tight density. They
// are the highest-frequency controls in Settings (clipboard sampling, file
// watching, loot rules) and the ones that most need a precise click, so the
// smallest target in the app was also the most consequential.
//
// The box stays 16px — that is the icon size §4 allows and a 24px box would
// read as a different control. The ROW is what grows: `min-h-8` (32px) with
// the label filling it, so the clickable area is the whole line and the box
// keeps its visual weight.
//
// `align="start"` is for a row whose label wraps to several lines (a loot rule
// with its description): the box aligns to the first line instead of floating
// to the middle of a paragraph.

export function CheckRow({ checked, onChange, label, children, align = 'center', disabled, testId, inputTestId, ariaLabel }: {
  checked: boolean
  /** Receives the next value, plus the raw event for a caller that needs it. */
  onChange: (next: boolean, event: React.ChangeEvent<HTMLInputElement>) => void
  /** The row's text. Kept as a prop rather than children so the layout stays
   *  one line of control + label; extra content goes in `children` below. */
  label: ReactNode
  children?: ReactNode
  align?: 'center' | 'start'
  disabled?: boolean
  testId?: string
  inputTestId?: string
  /** Overrides the visible label as the accessible name, for a row whose
   *  visible text is a short id and whose real meaning is longer. */
  ariaLabel?: string
}): JSX.Element {
  return (
    <label
      data-testid={testId}
      className={`flex gap-2 min-h-8 py-1 cursor-pointer ${
        align === 'start' ? 'items-start' : 'items-center'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked, e)}
        data-testid={inputTestId}
        aria-label={ariaLabel}
        className={`w-4 h-4 shrink-0 accent-red-600 ${align === 'start' ? 'mt-0.5' : ''}`}
      />
      <span className="min-w-0 flex-1 text-xs text-redlog-text">{label}</span>
      {children}
    </label>
  )
}
