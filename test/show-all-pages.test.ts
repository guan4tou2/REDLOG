// @vitest-environment jsdom
//
// §22's escape hatch. The interesting property is not the read/write pair — it
// is that the preference is scoped to ONE project. Switching projects reloads
// the same origin, so a global key would mean one tick during one engagement
// turns disclosure off for every engagement afterwards.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  storedShowAllPages, setShowAllPages, showAllPagesKey, SHOW_ALL_PAGES_EVENT
} from '../src/renderer/src/lib/showAllPages'

beforeEach(() => localStorage.clear())

describe('the show-all-pages preference', () => {
  it('is off unless it was explicitly turned on', () => {
    expect(storedShowAllPages('p1')).toBe(false)
    setShowAllPages('p1', true)
    expect(storedShowAllPages('p1')).toBe(true)
  })

  it('is scoped to one project', () => {
    setShowAllPages('p1', true)
    expect(storedShowAllPages('p2'), 'the preference leaked to another engagement').toBe(false)
  })

  it('turns off again cleanly', () => {
    setShowAllPages('p1', true)
    setShowAllPages('p1', false)
    expect(storedShowAllPages('p1')).toBe(false)
    expect(localStorage.getItem(showAllPagesKey('p1'))).toBeNull()
  })

  it('reads anything unrecognised as off — a storage failure lands on the design', () => {
    localStorage.setItem(showAllPagesKey('p1'), 'yes')
    expect(storedShowAllPages('p1')).toBe(false)
    expect(storedShowAllPages(null)).toBe(false)
    expect(storedShowAllPages(undefined)).toBe(false)
  })

  it('announces the change so the shell re-reads without a reload', () => {
    let heard = 0
    const onChange = (): void => { heard += 1 }
    window.addEventListener(SHOW_ALL_PAGES_EVENT, onChange)
    setShowAllPages('p1', true)
    expect(heard).toBe(1)
    window.removeEventListener(SHOW_ALL_PAGES_EVENT, onChange)
  })
})
