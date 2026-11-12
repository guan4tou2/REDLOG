// @vitest-environment jsdom
//
// #692 (guard only): a narrow Timeline pane has no room for the detail beside
// the list. Below 960px it docks at the bottom, as HTTP History's does; the
// stored "right" is left alone and comes back when the pane is wide again.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, page } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const KEY = 'redlog-timeline-detail-layout'
const TO_BOTTOM = (en as Record<string, string>)['timeline.layoutToBottom']
const TO_RIGHT = (en as Record<string, string>)['timeline.layoutToRight']
let width = 800

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  localStorage.setItem(KEY, 'right')
  const b = installTimelineBridge({ timelineMode: 'standard' })
  b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 1000), makeEvent('e2', T0)]))
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mount = (): void => {
  render(<I18nProvider><FilterProvider><TimelinePanel focusEventId="e1" /></FilterProvider></I18nProvider>)
}

it('docks the detail at the bottom in a narrow pane, without the dock switch, and keeps the stored choice', async () => {
  width = 800
  mount()
  await waitFor(() => expect(screen.getByTestId('timeline-split').getAttribute('data-layout')).toBe('bottom'))
  expect(screen.queryByRole('button', { name: TO_BOTTOM })).toBeNull()
  expect(screen.queryByRole('button', { name: TO_RIGHT })).toBeNull()
  expect(localStorage.getItem(KEY)).toBe('right')
})

it('puts it back beside the list when the pane is wide again', async () => {
  width = 800
  mount()
  await waitFor(() => expect(screen.getByTestId('timeline-split').getAttribute('data-layout')).toBe('bottom'))
  width = 1400
  window.dispatchEvent(new Event('resize'))
  await waitFor(() => expect(screen.getByTestId('timeline-split').getAttribute('data-layout')).toBe('right'))
  expect(screen.getByRole('button', { name: TO_BOTTOM })).toBeTruthy()
  expect(localStorage.getItem(KEY)).toBe('right')
})
