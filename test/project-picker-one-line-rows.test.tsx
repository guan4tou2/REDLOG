// @vitest-environment jsdom
//
// Project rows are one line — name, scope badge, last opened, size — so the
// list shows more than the five two-line rows a fixed 380px scroller held.
// "Created …" moves to the row's title; the leading red dot that only
// mirrored the selection (and read as a state) is gone; the list takes the
// panel's height instead of a fixed one. "Scope not set", the normal state
// of a new project, is the quietest badge.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { I18nProvider } from '../src/renderer/src/i18n'
import { formatDate } from '../src/renderer/src/lib/time'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const DAY = 24 * 60 * 60 * 1000
const CREATED = Date.UTC(2026, 0, 2, 12)
const OLD = Date.now() - 3 * DAY

function mount(scope: Record<string, unknown> = {}): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: {
      list: async () => [
        { id: 'today', name: 'Today-Lab', createdAt: CREATED, lastOpened: Date.now() - 60_000, path: '/tmp/today', dbSize: 1024 },
        { id: 'old', name: 'Old-Lab', createdAt: CREATED, lastOpened: OLD, path: '/tmp/old', dbSize: 2048 }
      ],
      create: vi.fn(), open: async () => null, delete: async () => true, rename: async () => ({ ok: true }),
      scopeSummaries: async () => scope
    },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /></I18nProvider>)
}
const row = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('button', { name })).closest('[role="option"]') as HTMLElement

describe('one-line project rows', () => {
  it('moves "Created" into the row title and draws no leading dot', async () => {
    mount()
    const r = await row('Today-Lab')
    expect(r.textContent).not.toMatch(/Created/)
    expect(r.getAttribute('title')).toBe(`Created ${formatDate(CREATED)}`)
    expect(r.querySelector('.rounded-full')).toBeNull()
  })

  it('says how long ago it was opened, with the date when that was not today', async () => {
    mount()
    const today = await row('Today-Lab')
    expect(today.textContent).toContain('1m ago')
    expect(today.textContent).not.toContain(formatDate(Date.now()))
    const old = await row('Old-Lab')
    expect(old.textContent).toContain('3d ago')
    expect(old.textContent).toContain(formatDate(OLD))
  })

  it('lets the list take the panel height instead of a fixed 380px', async () => {
    mount()
    await row('Today-Lab')
    const list = screen.getByTestId('project-list')
    expect(list.className).not.toMatch(/max-h-\[380px\]/)
    expect(list.className).toMatch(/\bmin-h-0\b/)
    expect(list.className).toMatch(/\boverflow-y-auto\b/)
    expect((list.parentElement as HTMLElement).className).toMatch(/\bmin-h-0\b/)
  })

  it('draws "Scope not set" quieter than a set scope: no fill, no border', async () => {
    mount({ today: { state: 'unset' }, old: { state: 'set', count: 3 } })
    await waitFor(() => expect(screen.getAllByTestId('project-scope-badge')).toHaveLength(2))
    const [unset, set] = ['unset', 'set'].map((s) => document.querySelector(`[data-testid="project-scope-badge"][data-state="${s}"]`) as HTMLElement)
    expect(unset.className).not.toMatch(/\bbg-/)
    expect(unset.className).toMatch(/\bborder-transparent\b/)
    expect(set.className).toMatch(/\bborder-redlog-border\b/)
  })
})
