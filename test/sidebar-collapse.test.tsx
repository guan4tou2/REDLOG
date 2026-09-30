// @vitest-environment jsdom
//
// The sidebar folds to an icon rail. §3.5 allows icon-only here and almost
// nowhere else: navigation is the highest-frequency thing in the app, every
// row keeps its ⌘N chord, and the tooltip names it. What must survive the fold
// is reachability — a rail that drops the accessible name is a rail nobody can
// use with a screen reader or learn from.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar'
import { storedSidebarCollapsed } from '../src/renderer/src/lib/sidebarCollapsed'

const VIEWS = new Set(['dashboard', 'timeline', 'terminal'] as const)
/** Every page on — the state that used to clip the footer off the bottom. */
const ALL = undefined

function draw(views: unknown = VIEWS): void {
  render(
    <I18nProvider>
      <Sidebar active="dashboard" onNavigate={vi.fn()} visibleViews={views as never} projectId="p1" />
    </I18nProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('redlog-locale', 'zh-TW')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getCount: vi.fn(async () => 0), onNewBatch: () => () => {} },
    loot: { getCount: vi.fn(async () => 0) },
    scope: { getViolationCount: vi.fn(async () => 0), isConfigured: vi.fn(async () => true) },
    config: { get: vi.fn(async () => ({})) },
    targetContext: { get: vi.fn(async () => null), onChange: () => () => {}, set: vi.fn() }
  }
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('the sidebar rail', () => {
  it('starts expanded, because a rail has to be learned first', () => {
    draw()
    expect(storedSidebarCollapsed()).toBe(false)
    expect(screen.getByText('儀表板')).toBeTruthy()
  })

  it('folds to icons and keeps every row reachable by name', () => {
    draw()
    fireEvent.click(screen.getByTestId('sidebar-collapse'))
    // The label is gone from the page...
    expect(screen.queryByText('儀表板')).toBeNull()
    // ...but not from the row: the chord is still in its accessible name.
    const row = screen.getByTestId('sidebar-collapse').closest('nav')!
      .querySelector('[data-view-btn="timeline"]') as HTMLElement
    expect(row.getAttribute('aria-label')).toContain('時間軸')
    expect(row.getAttribute('title')).toMatch(/⌘2|Ctrl\+2/)
  })

  it('remembers the choice', () => {
    draw()
    fireEvent.click(screen.getByTestId('sidebar-collapse'))
    expect(storedSidebarCollapsed()).toBe(true)
    fireEvent.click(screen.getByTestId('sidebar-collapse'))
    expect(storedSidebarCollapsed()).toBe(false)
  })

  it('drops the hidden-pages sentence, which is prose a rail has no room for', () => {
    draw()
    expect(screen.getByTestId('sidebar-show-all')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sidebar-collapse'))
    expect(screen.queryByTestId('sidebar-show-all')).toBeNull()
  })

  it('keeps the footer reachable when every page is on', () => {
    draw(ALL)
    // The rows scroll in their own band; Settings and the collapse toggle are
    // not pushed off the bottom of a nav that does not scroll.
    const rows = screen.getByTestId('sidebar-collapse').closest('nav')!
      .querySelector('[data-view-btn="dashboard"]')!.parentElement!
    expect(rows.className).toMatch(/overflow-y-auto/)
    expect(rows.className).toMatch(/flex-1/)
    expect(screen.getByTestId('sidebar-collapse')).toBeTruthy()
    expect(screen.getByText('設定')).toBeTruthy()
  })
})
