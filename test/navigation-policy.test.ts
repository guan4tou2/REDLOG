import { describe, it, expect } from 'vitest'
import { allowNavigation } from '../src/main/navigation-policy'

const own = 'file:///app/out/renderer/index.html'

describe('will-navigate policy', () => {
  it('allows a reload of the window\'s own URL', () => {
    expect(allowNavigation(own, own)).toBe(true)
    expect(allowNavigation(own + '#x', own)).toBe(true)
  })
  it('denies any other file:// URL', () => {
    expect(allowNavigation('file:///Users/x/evil.html', own)).toBe(false)
    expect(allowNavigation('file:///app/out/renderer/overlay.html', own)).toBe(false)
  })
  it('denies http(s)', () => {
    expect(allowNavigation('https://example.com/', own)).toBe(false)
    expect(allowNavigation('http://localhost:5173/', own)).toBe(false)
  })
  it('allows the dev server origin only when it is set', () => {
    expect(allowNavigation('http://localhost:5173/overlay.html', own, 'http://localhost:5173')).toBe(true)
    expect(allowNavigation('http://localhost:5173/', own, undefined)).toBe(false)
    expect(allowNavigation('http://localhost:5174/', own, 'http://localhost:5173')).toBe(false)
    expect(allowNavigation('http://localhost:5173.evil.com/', own, 'http://localhost:5173')).toBe(false)
  })
})
