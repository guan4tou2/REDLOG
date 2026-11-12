// @vitest-environment jsdom
//
// ⌘K could not open the palette while the built-in Terminal had focus: xterm
// keeps a hidden <textarea class="xterm-helper-textarea"> focused, and the
// app's "am I typing?" guard read it as a text field.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppShortcuts } from '../src/renderer/src/hooks/useAppShortcuts'

let palette: ReturnType<typeof vi.fn>
let find: ReturnType<typeof vi.fn>
let field: HTMLTextAreaElement

function press(target: HTMLElement, init: KeyboardEventInit, prevent = false): void {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (prevent) e.preventDefault()
  target.dispatchEvent(e)
}

beforeEach(() => {
  palette = vi.fn()
  find = vi.fn()
  window.addEventListener('redlog:find-in-page', find)
  renderHook(() => useAppShortcuts({ id: 'p1', name: 'P' }, 'terminal', vi.fn(), palette, (k) => k))
  field = document.createElement('textarea')
  document.body.appendChild(field)
})
afterEach(() => { window.removeEventListener('redlog:find-in-page', find); field.remove(); cleanup() })

it('opens the palette on ⌘K and Ctrl+K from the terminal’s helper textarea', () => {
  field.className = 'xterm-helper-textarea'
  press(field, { key: 'k', metaKey: true })
  press(field, { key: 'k', ctrlKey: true })
  expect(palette).toHaveBeenCalledTimes(2)
})

it('still yields ⌘K to an ordinary text field', () => {
  press(field, { key: 'k', metaKey: true })
  expect(palette).not.toHaveBeenCalled()
})

it('leaves ⌘F to the terminal’s own search', () => {
  field.className = 'xterm-helper-textarea'
  press(field, { key: 'f', metaKey: true })
  expect(find).not.toHaveBeenCalled()
})

it('leaves a chord the terminal already handled', () => {
  field.className = 'xterm-helper-textarea'
  press(field, { key: 'k', metaKey: true }, true)
  expect(palette).not.toHaveBeenCalled()
})
