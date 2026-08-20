import { useCallback, useEffect, useRef, useState } from 'react'

// One keyboard contract for every list in the app (docs/UIUX-STANDARD.md §9).
//
// Findings, Loot, Targets, Scope violations, Screenshots and Search results
// are the same interaction wearing six different component names, and each one
// had arrived at a different answer to "what does the keyboard do here" —
// mostly the answer "nothing". An operator who has learnt one list should not
// have to discover the next.
//
//   ↑ ↓        move the selection
//   Home End   first / last
//   Enter      activate — expand the row, or open it
//   ⌘/Ctrl ↩   jump to this row on the Timeline
//   Escape     back out one level: clear the selection, then let it bubble
//
// Roving tabindex rather than a tabbable row per item: a hundred loot rows
// should be one Tab stop, not a hundred, and the selected row is the one that
// carries focus so a screen reader announces it on arrival.

export interface ListKeyboardOptions {
  /** How many rows there are. Selection is clamped when this shrinks. */
  count: number
  /** Enter, and click. */
  onActivate?: (index: number) => void
  /** ⌘/Ctrl + Enter. Omit on lists with no timeline counterpart. */
  onJumpToTimeline?: (index: number) => void
  /** Escape with nothing selected — usually "close this panel". */
  onEscape?: () => void
  /** Turn the whole thing off while a modal is up. */
  enabled?: boolean
}

export interface ListKeyboard {
  index: number
  setIndex: (i: number) => void
  /** Spread onto the scroll container. */
  containerProps: {
    role: 'listbox'
    tabIndex: number
    onKeyDown: (e: React.KeyboardEvent) => void
  }
  /** Spread onto each row. */
  itemProps: (i: number) => {
    role: 'option'
    'aria-selected': boolean
    tabIndex: number
    ref: (el: HTMLElement | null) => void
    onClick: () => void
  }
}

export function useListKeyboard(opts: ListKeyboardOptions): ListKeyboard {
  const { count, onActivate, onJumpToTimeline, onEscape, enabled = true } = opts
  const [index, setIndex] = useState(-1)
  const rows = useRef<Array<HTMLElement | null>>([])

  // A list that shrinks under the selection (a filter narrowing, an event
  // being removed) must not leave `index` pointing past the end.
  useEffect(() => {
    setIndex((i) => (i >= count ? count - 1 : i))
  }, [count])

  // Keep the selected row on screen. `nearest` rather than `center` so
  // arrowing down a long list scrolls by a row instead of jumping.
  useEffect(() => {
    if (index < 0) return
    // Optional-called: `scrollIntoView` is absent under jsdom, and a list that
    // cannot be exercised in a test is a list whose keyboard rots.
    rows.current[index]?.scrollIntoView?.({ block: 'nearest' })
    rows.current[index]?.focus({ preventScroll: true })
  }, [index])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!enabled || count === 0) return
    const move = (next: number): void => {
      e.preventDefault()
      setIndex(Math.max(0, Math.min(count - 1, next)))
    }
    switch (e.key) {
      case 'ArrowDown': return move(index < 0 ? 0 : index + 1)
      case 'ArrowUp': return move(index < 0 ? count - 1 : index - 1)
      case 'Home': return move(0)
      case 'End': return move(count - 1)
      case 'Enter': {
        if (index < 0) return
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) onJumpToTimeline?.(index)
        else onActivate?.(index)
        return
      }
      case 'Escape': {
        // One level at a time (§5.7). Only take Escape if there is a
        // selection to drop; otherwise let it reach whatever is outside.
        if (index >= 0) {
          e.preventDefault()
          setIndex(-1)
        } else {
          onEscape?.()
        }
      }
    }
  }, [enabled, count, index, onActivate, onJumpToTimeline, onEscape])

  const itemProps = useCallback((i: number) => ({
    role: 'option' as const,
    'aria-selected': i === index,
    tabIndex: i === index ? 0 : -1,
    ref: (el: HTMLElement | null): void => { rows.current[i] = el },
    onClick: (): void => setIndex(i)
  }), [index])

  return {
    index,
    setIndex,
    containerProps: { role: 'listbox', tabIndex: index >= 0 ? -1 : 0, onKeyDown },
    itemProps
  }
}
