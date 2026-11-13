// @vitest-environment jsdom
//
// Spec 074 T014 (US5), the RED half of what 074 changes: a count must never
// claim more rows shown than exist. Once every screenshot is loaded the view
// says "Showing 5 of 5"; a screenshot that arrives live is prepended to the
// list, but the total comes from the load, so the line then reads "Showing 6
// of 5". Plan.md 「閘門」(count-semantics): shown <= exact total.
//
// The assertion states the correct behaviour and is `it.fails` until Phase 6
// computes the total from the same source as the rows.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'

const shot = (n: number): Record<string, unknown> => ({
  id: `s${n}`, timestamp: 1_000_000 + n, agentType: 'screenshot', targetId: null,
  data: { filename: `s${n}.png`, filePath: `/x/s${n}.png`, trigger: 'manual', sha256: `sha-${n}`.padEnd(64, '0') }
})

let listeners: Set<(events: unknown[]) => void>
function install(items: unknown[]): void {
  listeners = new Set()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryScreenshotPage: vi.fn(async () => ({ items, hasMore: false, nextCursor: null })),
      onNewBatch: (cb: (events: unknown[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) }
    },
    screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) },
    artifacts: { reveal: vi.fn(async () => true) }
  }
}
beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => cleanup())

const summary = (): { shown: number; total: number } => {
  const m = /Showing (\d+) of (\d+)/.exec(screen.getByTestId('screenshots-summary').textContent ?? '')
  if (!m) throw new Error(`summary is not "Showing x of y": ${screen.getByTestId('screenshots-summary').textContent}`)
  return { shown: Number(m[1]), total: Number(m[2]) }
}

it('says "Showing 5 of 5" once all five are loaded (the pin: the line exists and is exact before anything arrives)', async () => {
  install([5, 4, 3, 2, 1].map(shot))
  render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  expect(summary()).toEqual({ shown: 5, total: 5 })
})

it.fails('never shows more screenshots than the total it states, after a live one arrives', async () => {
  install([5, 4, 3, 2, 1].map(shot))
  render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  act(() => { for (const cb of listeners) cb([shot(6)]) })
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(6))
  const { shown, total } = summary()
  expect(shown, `the line reads "Showing ${shown} of ${total}"`).toBeLessThanOrEqual(total)
})
