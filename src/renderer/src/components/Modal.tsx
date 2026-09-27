// One modal behaviour for every dialog (UI/UX audit F16, UIUX-STANDARD §4/§9).
//
// Several dialogs were a fixed div with a backdrop and nothing else: no
// `role="dialog"`, no focus trap, no Escape — among them the consent dialog
// for running a red-tier plugin, which is a security decision. Each one had
// re-implemented part of ConfirmDialog and left the rest out. This carries
// the whole contract: role and name, focus moved in and kept in, Escape and
// backdrop dismiss, and focus returned to what opened it.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'

export function Modal({
  open, onClose, label, children, panelClassName, backdropClassName, testId,
  initialFocus, dismissOnBackdrop = true, alert = false
}: {
  open: boolean
  onClose: () => void
  /** Accessible name of the dialog. */
  label: string
  children: ReactNode
  panelClassName?: string
  backdropClassName?: string
  testId?: string
  initialFocus?: RefObject<HTMLElement | null>
  /** A backdrop click closes it; off for a decision that must be answered. */
  dismissOnBackdrop?: boolean
  /** `alertdialog`: a decision with consequences, announced as such. */
  alert?: boolean
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open, initialFocus)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className={backdropClassName ?? 'fixed inset-0 z-50 flex items-center justify-center bg-black/60'}
      onClick={(e) => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      <div
        ref={panel}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        className={`outline-none ${panelClassName ?? ''}`}
      >
        {children}
      </div>
    </div>
  )
}
