// A toolbar button that opens a small non-modal panel under itself: the
// Timeline's legend and the attribution status's details. Escape or a press
// outside closes it; Escape hands focus back to the button, so a keyboard
// operator lands where they started.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function ToolbarPopover({ label, buttonTestId, panelTestId, panelLabel, buttonClassName, panelClassName, children }: {
  label: ReactNode
  buttonTestId: string
  panelTestId: string
  /** The panel's accessible name. */
  panelLabel: string
  buttonClassName: string
  panelClassName: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div
      ref={wrapRef}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        // Handled here: the Timeline's own Escape (close the detail pane,
        // leave focus mode) must not also fire.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid={buttonTestId}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >{label}</button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={panelLabel}
          tabIndex={-1}
          data-testid={panelTestId}
          className={`absolute top-full right-0 mt-1 z-40 rounded border border-redlog-border bg-redlog-surface shadow-xl focus:outline-none ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
