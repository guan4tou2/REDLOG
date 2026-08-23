import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'

// Who can export what, kept outside React so the shell's one export control
// (docs/UIUX-STANDARD.md §10) can offer a view's own scope without the shell
// having to know what views exist.
//
// The alternative was the shape this replaced: each view grew its own export
// button, worded its own way, because the view was the only place that knew
// what "this" meant. That put the same verb in six places and made the scope
// a property of where you clicked. Here the view contributes only the part it
// alone knows — how to serialise its current subset — and the menu stays the
// single place the verb appears.

export interface ViewExport {
  /** What the operator will recognise this subset as, in the menu. */
  label: string
  /** Resolves to the written path, or null if the operator cancelled. */
  run: () => Promise<string | null>
  /** Events in this subset, for the preview line. Omit if not countable. */
  count?: number
}

let current: ViewExport | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getViewExport(): ViewExport | null {
  return current
}

/** Read the currently contributed view export, in the shell. */
export function useViewExport(): ViewExport | null {
  return useSyncExternalStore(subscribe, getViewExport, () => null)
}

/**
 * Contribute this view's export while it is mounted.
 *
 * Registration is cleared on unmount, so navigating away cannot leave the menu
 * offering a subset that is no longer on screen — an export labelled "this
 * view" that quietly means the previous one is worse than no option at all.
 */
export function useContributeExport(entry: ViewExport | null): void {
  const label = entry?.label
  const count = entry?.count
  const run = entry?.run
  useEffect(() => {
    if (!label || !run) {
      return
    }
    current = { label, run, count }
    emit()
    return () => {
      current = null
      emit()
    }
  }, [label, count, run])
}
