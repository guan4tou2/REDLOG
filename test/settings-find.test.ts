// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { landOnSetting } from '../src/renderer/src/lib/settingsFind'

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

describe('landOnSetting', () => {
  it('marks the field once the page it belongs to has mounted', async () => {
    vi.useFakeTimers()
    landOnSetting('browser', 'settings.proxyListener', 'Proxy listener')
    // Settings mounts after the navigation, not before.
    document.body.innerHTML = '<div data-testid="settings-content" data-page="browser"><label>Proxy listener (point here)</label></div>'
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('label')?.classList.contains('ring-1')).toBe(true)
  })

  it('does not mark a match on another page', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div data-testid="settings-content" data-page="hooks"><label>Proxy listener</label></div>'
    landOnSetting('browser', 'k', 'Proxy listener')
    await vi.advanceTimersByTimeAsync(5000)
    expect(document.querySelector('label')?.classList.contains('ring-1')).toBe(false)
  })
})
