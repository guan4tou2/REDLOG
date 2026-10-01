// @vitest-environment jsdom
//
// The Timeline has two horizontal splits and only one of them could be
// dragged: the detail panel moved, the event log — the panel an operator
// reads all day — was frozen at 22vh. The machinery existed; it had been
// written into one panel instead of into a function.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePanelHeight } from '../src/renderer/src/hooks/usePanelHeight'

const KEY = 'test-panel-h'

/** `clientY` is a getter on jsdom's MouseEvent, so it goes through the ctor. */
const drag = (to: number): void => {
  act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientY: to })) })
}

beforeEach(() => {
  localStorage.clear()
  // jsdom reports 768; pin it so the clamp maths is not a guess.
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })
})
afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('a panel the operator drags', () => {
  it('starts at null, so the caller keeps its responsive default', () => {
    // Not a pixel count: the default has to follow window height rather than
    // freeze a number taken on somebody else's monitor.
    const { result } = renderHook(() => usePanelHeight(KEY))
    expect(result.current.px).toBeNull()
  })

  it('grows when dragged up, because the handle is on the top edge', () => {
    const { result } = renderHook(() => usePanelHeight(KEY))
    act(() => result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(400)
    expect(result.current.px).toBe(300)
  })

  it('shrinks when dragged down', () => {
    const { result } = renderHook(() => usePanelHeight(KEY))
    act(() => result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(560)
    expect(result.current.px).toBe(140)
  })

  it('cannot be dragged to nothing, or over the whole window', () => {
    const { result } = renderHook(() => usePanelHeight(KEY, { min: 64, maxRatio: 0.7 }))
    act(() => result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(5000)
    expect(result.current.px).toBe(64)
    drag(-5000)
    expect(result.current.px).toBe(700)
  })

  it('persists on mouseup, not on every pixel of the drag', () => {
    const { result } = renderHook(() => usePanelHeight(KEY))
    act(() => result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(400)
    expect(localStorage.getItem(KEY)).toBeNull()
    act(() => { window.dispatchEvent(new MouseEvent('mouseup')) })
    expect(localStorage.getItem(KEY)).toBe('300')
  })

  it('writes the size the drag ENDED on', () => {
    // The listener is installed once and must read the live value. Reading the
    // render's own copy would persist whatever the first mousemove set.
    const { result } = renderHook(() => usePanelHeight(KEY))
    act(() => result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(450)
    drag(300)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup')) })
    expect(localStorage.getItem(KEY)).toBe('400')
  })

  it('reads the stored size back on the next mount', () => {
    localStorage.setItem(KEY, '321')
    const { result } = renderHook(() => usePanelHeight(KEY))
    expect(result.current.px).toBe(321)
  })

  it('ignores a stored value outside the range, rather than trusting storage', () => {
    localStorage.setItem(KEY, '3')
    expect(renderHook(() => usePanelHeight(KEY)).result.current.px).toBeNull()
    localStorage.setItem(KEY, '99999')
    expect(renderHook(() => usePanelHeight(KEY)).result.current.px).toBeNull()
    localStorage.setItem(KEY, 'not a number')
    expect(renderHook(() => usePanelHeight(KEY)).result.current.px).toBeNull()
  })

  it('resets to the responsive default and forgets the stored size', () => {
    localStorage.setItem(KEY, '321')
    const { result } = renderHook(() => usePanelHeight(KEY))
    act(() => result.current.reset())
    expect(result.current.px).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('ignores a mousemove that no drag started', () => {
    const { result } = renderHook(() => usePanelHeight(KEY))
    drag(100)
    expect(result.current.px).toBeNull()
  })

  // The same panel laid out on the other axis is the other case of "two keys",
  // and the one the initializer could not see: the key changed under a mounted
  // hook. 320px of height came back as 320px of width.
  describe('the same panel on the other axis', () => {
    const mount = (key: string, opts?: { min?: number; axis?: 'x' | 'y' }) =>
      renderHook(({ k, o }: { k: string; o?: { min?: number; axis?: 'x' | 'y' } }) => usePanelHeight(k, o),
        { initialProps: { k: key, o: opts } })

    it('re-reads storage when the key changes', () => {
      localStorage.setItem('panel-h', '320')
      localStorage.setItem('panel-w', '500')
      const { result, rerender } = mount('panel-h')
      expect(result.current.px).toBe(320)
      rerender({ k: 'panel-w', o: { min: 280, axis: 'x' } })
      expect(result.current.px).toBe(500)
    })

    it('falls back to the caller default when the new key has nothing stored', () => {
      // Not the old axis's number. A pane that has never been dragged beside
      // the list is a pane the side layout gets to size itself.
      localStorage.setItem('panel-h', '320')
      const { result, rerender } = mount('panel-h')
      expect(result.current.px).toBe(320)
      rerender({ k: 'panel-w', o: { min: 280, axis: 'x' } })
      expect(result.current.px).toBeNull()
    })

    it('applies the new key\'s floor, not the one it mounted with', () => {
      localStorage.setItem('panel-h', '320')
      localStorage.setItem('panel-w', '120')
      const { result, rerender } = mount('panel-h')
      rerender({ k: 'panel-w', o: { min: 280, axis: 'x' } })
      expect(result.current.px).toBeNull()
    })

    it('writes a later drag under the key it is now on', () => {
      localStorage.setItem('panel-h', '320')
      const { result, rerender } = mount('panel-h')
      rerender({ k: 'panel-w', o: { min: 280, axis: 'x' } })
      act(() => result.current.beginResize({ clientX: 500, preventDefault: () => {} }, 400))
      act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })) })
      act(() => { window.dispatchEvent(new MouseEvent('mouseup')) })
      expect(localStorage.getItem('panel-w')).toBe('500')
      expect(localStorage.getItem('panel-h')).toBe('320')
    })
  })

  it('keeps two panels apart, because they are two keys', () => {
    const a = renderHook(() => usePanelHeight('panel-a'))
    const b = renderHook(() => usePanelHeight('panel-b'))
    act(() => a.result.current.beginResize({ clientY: 500, preventDefault: () => {} }, 200))
    drag(400)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup')) })
    expect(localStorage.getItem('panel-a')).toBe('300')
    expect(localStorage.getItem('panel-b')).toBeNull()
    expect(b.result.current.px).toBeNull()
  })
})
