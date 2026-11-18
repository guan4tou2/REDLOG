// @vitest-environment jsdom
//
// Spec 074 T014 (US5): a count must never claim more rows shown than exist.
// The line used to say "Showing 5 of 5" once everything was loaded, with the
// total taken from the load, so a screenshot arriving live made it "Showing 6
// of 5". Plan.md 「閘門」(count-semantics): shown <= exact total. The line now
// counts only against the rows it holds, and is absent when they are all of
// them (the Evidence tab states the project's count).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// The project-wide count is said once, by the Evidence tab. The line under the
// toolbar speaks only when what is shown is not everything: more to load, or a
// search over what is loaded.
it('states no count of its own once everything is loaded (the tab carries it)', async () => {
  install([5, 4, 3, 2, 1].map(shot))
  render(<I18nProvider><ScreenshotsView /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  expect(screen.queryByTestId('screenshots-summary')).toBeNull()
})

it('counts a search against what is loaded, and stays exact when a live one arrives', async () => {
  install([5, 4, 3, 2, 1].map(shot))
  render(<I18nProvider><ScreenshotsView /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  fireEvent.change(screen.getByTestId('screenshots-search'), { target: { value: 's' } })
  expect(summary()).toEqual({ shown: 5, total: 5 })
  act(() => { for (const cb of listeners) cb([shot(6)]) })
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(6))
  const { shown, total } = summary()
  expect(shown, `the line reads "Showing ${shown} of ${total}"`).toBeLessThanOrEqual(total)
  expect(total).toBe(6)
})

// A filtered, complete list printed the first-page count across ALL
// triggers as its total ("Showing 1 of 3" for a filter that had one).
it("never states another set's total under a trigger filter", async () => {
  const mixed = [shot(3), { ...shot(2), data: { ...(shot(2).data as object), trigger: 'api' } }, shot(1)]
  ;(window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events.queryScreenshotPage = vi.fn(
    async ({ trigger }: { trigger?: string | null }) => ({ items: trigger ? mixed.filter((m) => (m.data as { trigger: string }).trigger === trigger) : mixed, hasMore: false, nextCursor: null }))
  render(<I18nProvider><ScreenshotsView /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  fireEvent.click(screen.getByRole('button', { name: /^API/ }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(1))
  expect(screen.queryByTestId('screenshots-summary')?.textContent ?? '').not.toMatch(/of 3/)
})
