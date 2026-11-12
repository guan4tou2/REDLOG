// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const KEY = 'redlog-timeline-focus-event'

// The Timeline's keys are on the window. The FilterBar's selects sit above the
// track in the same view, and the arrows on a focused one were taken: the
// default prevented, the Timeline's selection moved, the option did not.
describe('the Timeline keys beside a focused select', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0), makeEvent('e2', T0 + 1000), makeEvent('e3', T0 + 2000)]))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const mount = (): { select: HTMLSelectElement; button: HTMLButtonElement } => {
    const view = render(
      <I18nProvider><FilterProvider>
        <select data-testid="sel"><option>a</option><option>b</option></select>
        <button type="button" data-testid="btn">x</button>
        <TimelinePanel focusEventId="e2" />
      </FilterProvider></I18nProvider>
    )
    return {
      select: view.getByTestId('sel') as HTMLSelectElement,
      button: view.getByTestId('btn') as HTMLButtonElement
    }
  }

  it('leaves the arrows, Home/End and zoom keys to the select', async () => {
    const { select } = mount()
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('e2'))
    select.focus()
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'Home', 'End', '+', '-', '0']) {
      // fireEvent returns false when the default was prevented.
      expect(fireEvent.keyDown(select, { key }), key).toBe(true)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(localStorage.getItem(KEY)).toBe('e2')
  })

  it('still moves the selection from a focused button', async () => {
    const { button } = mount()
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('e2'))
    button.focus()
    expect(fireEvent.keyDown(button, { key: 'ArrowRight' })).toBe(false)
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('e3'))
  })
})
