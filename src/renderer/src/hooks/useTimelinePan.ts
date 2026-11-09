import { useCallback, useEffect, useRef, type RefObject, type MouseEvent as ReactMouseEvent } from 'react'

/** Track gestures own drag state and suppress the click synthesized after a pan. */
export function useTimelinePan(scroll: RefObject<HTMLDivElement | null>, onStart: () => void) {
  const dragging = useRef(false)
  const start = useRef({ x: 0, scroll: 0 })
  const didPan = useRef(false)
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart
  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement | null)?.closest('[data-timeline-popup]')) return
    onStartRef.current()
    dragging.current = true
    didPan.current = false
    start.current = { x: event.clientX, scroll: scroll.current?.scrollLeft ?? 0 }
    document.body.classList.add('timeline-grabbing')
  }, [scroll])
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current || !scroll.current) return
      const dx = event.clientX - start.current.x
      if (Math.abs(dx) > 4) didPan.current = true
      scroll.current.scrollLeft = start.current.scroll - dx
    }
    const up = () => {
      dragging.current = false
      document.body.classList.remove('timeline-grabbing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      up()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [scroll])
  return { didPan, handleMouseDown }
}
