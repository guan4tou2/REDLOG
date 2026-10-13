// @vitest-environment jsdom
//
// #298. At the window's 800px floor with the shell zoomed to 150%, the page had
// 592 layout pixels and the main sidebar plus Settings' 212px category column
// took two thirds of them: the Scope editor was below the fold, with no
// scrollbar to say so. Narrow, the sidebar takes the rail and Settings' pages
// become a select above the content.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar'
import Settings from '../src/renderer/src/components/Settings'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'
import { LaunchBrowserButton } from '../src/renderer/src/components/DashboardView'
import { useNarrowViewport } from '../src/renderer/src/hooks/useNarrowViewport'
import { storedSidebarCollapsed } from '../src/renderer/src/lib/sidebarCollapsed'

const WIDE = 1280
const NARROW = 600

function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

const CONFIG = {
  engagement: { id: 'proj-a', name: 'A' },
  operator: { id: 'op' },
  overlay: {},
  packs: {},
  screenshot: {},
  clipboard: {},
  processMonitor: {},
  connectionMonitor: {},
  fileWatcher: {},
  scope: { targets: [], excludeTargets: [], personalDomains: [] }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('redlog-locale', 'zh-TW')
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: WIDE })
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    platform: 'win32',
    events: { getCount: vi.fn(async () => 0), onNewBatch: () => () => {} },
    loot: { getCount: vi.fn(async () => 0) },
    chain: { length: vi.fn(async () => 0) },
    scope: { getViolationCount: vi.fn(async () => 0), isConfigured: vi.fn(async () => true) },
    config: { get: async () => structuredClone(CONFIG), save: async () => true },
    targetContext: { get: vi.fn(async () => null), onChange: () => () => {}, set: vi.fn() },
    project: { close: async () => {} },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }) },
    plugins: { list: async () => [], eventTypes: async () => [] },
    operators: { list: async () => [] }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('useNarrowViewport', () => {
  it('is false with room, true without, and follows a resize both ways', () => {
    const { result } = renderHook(() => useNarrowViewport())
    expect(result.current).toBe(false)
    resizeTo(NARROW)
    expect(result.current).toBe(true)
    resizeTo(WIDE)
    expect(result.current).toBe(false)
  })

  it('counts the body zoom: the same window is narrower when drawn larger', () => {
    // 800 / 0.9 = 889 layout pixels at the default; 800 / 1.26 = 635 at the
    // largest UI scale, which is below the line.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 800 })
    expect(renderHook(() => useNarrowViewport()).result.current).toBe(false)
    document.body.style.zoom = '1.26'
    try {
      expect(renderHook(() => useNarrowViewport()).result.current).toBe(true)
    } finally {
      document.body.style.zoom = ''
    }
  })
})

describe('the main sidebar in a narrow layout', () => {
  const draw = (): void => {
    render(
      <I18nProvider>
        <Sidebar active="dashboard" onNavigate={vi.fn()} projectId="p1" />
      </I18nProvider>
    )
  }

  it('is the full sidebar when there is room', () => {
    draw()
    expect(screen.getByText('儀表板')).toBeTruthy()
    expect(screen.getByTestId('sidebar-collapse')).toBeTruthy()
  })

  it('becomes the rail, keeps every row reachable by name, and offers no toggle that cannot work', () => {
    resizeTo(NARROW)
    draw()
    expect(screen.queryByText('儀表板')).toBeNull()
    const row = document.querySelector('[data-view-btn="timeline"]') as HTMLElement
    expect(row.getAttribute('aria-label')).toContain('時間軸')
    expect(screen.queryByTestId('sidebar-collapse')).toBeNull()
  })

  it('does not rewrite the operator\'s own choice, and gives the labels back with the room', () => {
    resizeTo(NARROW)
    draw()
    expect(storedSidebarCollapsed()).toBe(false)
    resizeTo(WIDE)
    expect(screen.getByText('儀表板')).toBeTruthy()
    expect(storedSidebarCollapsed()).toBe(false)
  })

  it('stays a rail on a wide window when the operator chose that', () => {
    localStorage.setItem('redlog-sidebar-collapsed', '1')
    draw()
    expect(screen.queryByText('儀表板')).toBeNull()
    expect(screen.getByTestId('sidebar-collapse')).toBeTruthy()
  })
})

describe('Settings in a narrow layout', () => {
  const draw = (): void => {
    render(<I18nProvider><Settings request={{ page: 'scope' }} /></I18nProvider>)
  }
  const ready = async (): Promise<void> => {
    await waitFor(() => expect(document.querySelector('[data-testid="settings-load-failed"]')).toBeNull())
    await screen.findByRole('navigation', { name: '設定分類' })
  }

  it('lists its pages down the side when there is room', async () => {
    draw()
    await ready()
    expect(document.querySelectorAll('[data-settings-page]').length).toBeGreaterThan(5)
    expect(screen.queryByTestId('settings-page-select')).toBeNull()
  })

  it('lists them as a select above the content when there is not', async () => {
    resizeTo(NARROW)
    draw()
    await ready()
    expect(document.querySelectorAll('[data-settings-page]')).toHaveLength(0)
    const select = screen.getByTestId('settings-page-select') as HTMLSelectElement
    // The page being shown is the one selected, and every page is reachable.
    expect(select.value).toBe('scope')
    const options = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(options).toEqual(expect.arrayContaining(['hooks', 'scope', 'general', 'about']))
  })

  it('switches page from the select', async () => {
    resizeTo(NARROW)
    draw()
    await ready()
    fireEvent.change(screen.getByTestId('settings-page-select'), { target: { value: 'about' } })
    expect((screen.getByTestId('settings-page-select') as HTMLSelectElement).value).toBe('about')
  })

  it('brings the page rows back for a query', async () => {
    resizeTo(NARROW)
    draw()
    await ready()
    fireEvent.change(screen.getByLabelText('搜尋設定…'), { target: { value: '範圍' } })
    // A query brings the page rows back: the select has no way to say "these
    // match".
    await waitFor(() => expect(document.querySelectorAll('[data-settings-page]').length).toBeGreaterThan(0))
  })
})

// The two title-bar controls with words on them give way first when the strip
// runs short, and keep their names for anything that is not looking at them.
describe('the title bar in a narrow layout', () => {
  const textOf = (el: HTMLElement): string => (el.textContent ?? '').trim()

  it('shows Export and Launch browser with their words when there is room', () => {
    render(
      <I18nProvider>
        <ExportMenu totalCount={1} />
        <LaunchBrowserButton onNavigate={vi.fn()} />
      </I18nProvider>
    )
    expect(textOf(screen.getByLabelText('匯出'))).toBe('匯出')
    expect(screen.getByRole('button', { name: '啟動擷取瀏覽器' })).toBeTruthy()
  })

  it('reduces both to icons that are still named and still say what they do', () => {
    resizeTo(NARROW)
    render(
      <I18nProvider>
        <ExportMenu totalCount={1} />
        <LaunchBrowserButton onNavigate={vi.fn()} />
      </I18nProvider>
    )
    const exportButton = screen.getByLabelText('匯出')
    expect(textOf(exportButton)).toBe('')
    expect(exportButton.getAttribute('title')).toBe('匯出')
    // Opening it is unchanged.
    fireEvent.click(exportButton)
    expect(exportButton.getAttribute('aria-expanded')).toBe('true')

    const launch = screen.getByRole('button', { name: '啟動擷取瀏覽器' })
    expect(textOf(launch)).toBe('')
    expect(launch.getAttribute('title')).toContain('啟動擷取瀏覽器')
  })
})
