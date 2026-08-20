import { useEffect, useRef, type RefObject } from 'react'

// Focus trap for modal surfaces (docs/UIUX-STANDARD.md §9, §4).
//
// Every dialog in the app was `aria-modal="true"` and none of them behaved
// like one: Tab walked straight out of the dialog and into the page behind it,
// which for a sighted mouse user is a curiosity and for a keyboard or screen
// reader user means the dialog is simply gone — focus is somewhere they cannot
// see, and the thing they were asked to confirm is still waiting.
//
// Three jobs, all of which have to be done together or none of them help:
//   - move focus into the dialog when it opens, at the element the caller
//     nominates (or the first tabbable one);
//   - keep Tab and Shift+Tab cycling inside it;
//   - put focus back where it came from when it closes, so dismissing a dialog
//     returns the operator to the control that opened it.

const TABBABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function tabbable(root: HTMLElement): HTMLElement[] {
  // `disabled` is already excluded by the selector. What is left to filter is
  // the hidden-but-rendered case. Deliberately not `offsetParent !== null`:
  // that is the usual test, but it depends on layout, so it reports every
  // element as hidden under jsdom and would make this untestable.
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true')
    .filter((el) => !el.closest('[hidden],[aria-hidden="true"]') || el.closest('[hidden],[aria-hidden="true"]') === el)
}

/**
 * Trap focus inside `ref` while `active`. `initial` names the element to focus
 * on open; without it, the first tabbable element gets focus.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true,
  initial?: RefObject<HTMLElement | null>
): void {
  // Captured at open, restored at close. Read from a ref rather than state so
  // a re-render mid-dialog cannot lose the element we have to go back to.
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return

    restoreTo.current = document.activeElement as HTMLElement | null
    const first = initial?.current ?? tabbable(root)[0] ?? root
    // A frame late: the dialog may still be animating in, and focusing an
    // element mid-transition scrolls the page on some platforms.
    const raf = requestAnimationFrame(() => first.focus())

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = tabbable(root)
      if (items.length === 0) {
        // Nothing to move to — hold focus on the dialog itself rather than
        // letting Tab escape to the page behind.
        e.preventDefault()
        root.focus()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const activeEl = document.activeElement
      if (!root.contains(activeEl)) {
        e.preventDefault()
        firstItem.focus()
      } else if (e.shiftKey && activeEl === firstItem) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && activeEl === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      // Restore only if nothing else has claimed focus in the meantime. Two
      // shapes count as "nothing else": focus is still inside the dialog, or
      // it has fallen to the body — which is the usual case, because a passive
      // effect's cleanup runs after React has already detached the node the
      // focused element lived in.
      const active = document.activeElement
      const ours = !active || active === document.body || root.contains(active)
      if (ours) restoreTo.current?.focus?.()
    }
  }, [ref, active, initial])
}
