// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeepScroll } from '../src/renderer/src/lib/useKeepScroll'

// #589: a hidden view loses its scroll offset; the hook puts it back.
let height = 2000
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  height = 2000
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function List({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepScroll(ref, active)
  return <div ref={ref} data-testid="list" />
}

function prep(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
}
const tick = (ms = 50) => act(() => { vi.advanceTimersByTime(ms) })

describe('useKeepScroll', () => {
  it('restores the offset when the view becomes active again', () => {
    const { getByTestId, rerender } = render(<List active />)
    const el = getByTestId('list'); prep(el)
    el.scrollTop = 900; fireEvent.scroll(el)
    rerender(<List active={false} />)
    el.scrollTop = 0 // what display:none does
    rerender(<List active />)
    tick()
    expect(el.scrollTop).toBe(900)
  })

  it('waits for the list to be tall enough before applying it', () => {
    const { getByTestId, rerender } = render(<List active />)
    const el = getByTestId('list'); prep(el)
    el.scrollTop = 900; fireEvent.scroll(el)
    rerender(<List active={false} />)
    el.scrollTop = 0; height = 300 // reloading
    rerender(<List active />)
    tick(100)
    expect(el.scrollTop).toBe(0)
    height = 2000
    tick(100)
    expect(el.scrollTop).toBe(900)
  })

  it('lets go as soon as the operator scrolls', () => {
    const { getByTestId, rerender } = render(<List active />)
    const el = getByTestId('list'); prep(el)
    el.scrollTop = 900; fireEvent.scroll(el)
    rerender(<List active={false} />)
    el.scrollTop = 0; height = 300
    rerender(<List active />)
    fireEvent.wheel(el)
    height = 2000
    tick(200)
    expect(el.scrollTop).toBe(0)
  })
})
