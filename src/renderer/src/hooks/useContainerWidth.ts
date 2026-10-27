import { useCallback, useLayoutEffect, useState } from 'react'

/** Logical CSS width, including Sidebar, UI scale and Electron zoom. */
export function useContainerWidth<T extends HTMLElement>(): readonly [(node: T | null) => void, number | null] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const ref = useCallback((node: T | null) => setElement(node), [])

  useLayoutEffect(() => {
    if (!element) return
    const update = (): void => {
      // Hidden retained panes have no layout. Keep their last useful width.
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [element])

  return [ref, width] as const
}
