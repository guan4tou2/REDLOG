// @vitest-environment jsdom
//
// Where the Timeline's detail pane sits is a trade, not a tidiness
// preference: the bottom gives a long stdout or an HTTP request the full
// width to read in, the right keeps the list's height for scanning. Which one
// is right changes several times a day, so it is a switch — and one whose
// stored size has to be per layout, because 320px of height and 320px of
// width are not the same request.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { storedDetailLayout, setDetailLayout, DETAIL_LAYOUT_EVENT } from '../src/renderer/src/lib/detailLayout'

beforeEach(() => localStorage.clear())

describe('the detail layout', () => {
  it('defaults to the bottom, where the wide content reads', () => {
    expect(storedDetailLayout()).toBe('bottom')
  })

  it('remembers the choice', () => {
    setDetailLayout('right')
    expect(storedDetailLayout()).toBe('right')
    setDetailLayout('bottom')
    expect(storedDetailLayout()).toBe('bottom')
  })

  it('stores nothing for the default, so a cleared profile reads as bottom', () => {
    setDetailLayout('right')
    setDetailLayout('bottom')
    expect(localStorage.getItem('redlog-timeline-detail-layout')).toBeNull()
  })

  it('reads anything unexpected as the default rather than trusting storage', () => {
    localStorage.setItem('redlog-timeline-detail-layout', 'sideways')
    expect(storedDetailLayout()).toBe('bottom')
  })

  it('tells the open view, so it switches without a reload', () => {
    const heard: string[] = []
    const h = (e: Event): void => { heard.push((e as CustomEvent).detail.layout) }
    window.addEventListener(DETAIL_LAYOUT_EVENT, h)
    setDetailLayout('right')
    setDetailLayout('bottom')
    window.removeEventListener(DETAIL_LAYOUT_EVENT, h)
    expect(heard).toEqual(['right', 'bottom'])
  })

  it('survives storage it cannot read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(storedDetailLayout()).toBe('bottom')
    spy.mockRestore()
  })
})
