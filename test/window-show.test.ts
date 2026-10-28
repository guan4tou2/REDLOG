import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { showWhenReady, SHOW_FALLBACK_MS } from '../src/main/window-show'

// The main window is created hidden and shown on `ready-to-show`. Found in the
// 2026-10-28 Windows acceptance: on that host (Intel Iris Xe, GPU compositing)
// a never-shown window never painted, so the event never came and every launch
// not restored maximized stayed hidden — `maximize()` was showing it, not the
// event. `--disable-gpu` brought it back. The window no longer waits on a paint
// that may not happen.

class FakeWindow extends EventEmitter {
  visible = false
  destroyed = false
  shows = 0
  webContents = new EventEmitter()
  isVisible(): boolean { return this.visible }
  isDestroyed(): boolean { return this.destroyed }
  show(): void { this.shows++; this.visible = true }
}

describe('the main window shows once it has loaded', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows on ready-to-show, and only once', () => {
    const win = new FakeWindow()
    showWhenReady(win)
    win.emit('ready-to-show')
    win.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(SHOW_FALLBACK_MS * 2)
    expect(win.shows).toBe(1)
  })

  it('shows after the page has loaded when no paint ever comes', () => {
    const win = new FakeWindow()
    showWhenReady(win)
    win.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(SHOW_FALLBACK_MS - 1)
    expect(win.shows).toBe(0)
    vi.advanceTimersByTime(1)
    expect(win.shows).toBe(1)
  })

  it('does not wait on a timer before the page has loaded', () => {
    const win = new FakeWindow()
    showWhenReady(win)
    vi.advanceTimersByTime(SHOW_FALLBACK_MS * 10)
    expect(win.shows).toBe(0)
  })

  it('leaves a window that was closed in the meantime alone', () => {
    const win = new FakeWindow()
    showWhenReady(win)
    win.webContents.emit('did-finish-load')
    win.destroyed = true
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(win.shows).toBe(0)
  })
})
