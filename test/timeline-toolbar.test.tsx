// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelineToolbar, formatSpan } from '../src/renderer/src/components/timeline/TimelineToolbar'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

type Props = Parameters<typeof TimelineToolbar>[0]

function Harness(over: Partial<Props>): JSX.Element {
  const { t } = useI18n()
  const props: Props = {
    t, timeRange: null, setTimeRange: vi.fn(), hasMore: false, loadedCount: 3, loadedSpanMs: 90 * 60_000, projectSpanMs: null,
    total: { state: 'ok', value: 3 }, onRetryTotal: vi.fn(), onLoadMore: vi.fn(),
    zoom: 1, onZoomOut: vi.fn(), onZoomIn: vi.fn(), onResetZoom: vi.fn(), anchorTs: null,
    mode: 'standard', onModeChange: vi.fn(),
    filterQuery: '', onFilterQueryChange: vi.fn(), searchInputRef: createRef<HTMLInputElement>(),
    onHelp: vi.fn(), attributionBlind: false, lanes: new Set(),
    moreItems: <span data-testid="more-slot" />, followBadge: <span data-testid="follow-slot" />,
    ...over
  }
  return <TimelineToolbar {...props} />
}
const draw = (over: Partial<Props> = {}): void => {
  try { localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
  render(<I18nProvider><Harness {...over} /></I18nProvider>)
}
afterEach(() => cleanup())

describe('TimelineToolbar', () => {
  it('range presets write the shared filter', () => {
    const setTimeRange = vi.fn()
    draw({ setTimeRange })
    fireEvent.click(screen.getByTestId('timeline-range-last1h'))
    const arg = setTimeRange.mock.calls[0][0] as { since: number }
    expect(Date.now() - arg.since).toBeLessThan(3_605_000)
    expect(Date.now() - arg.since).toBeGreaterThan(3_595_000)
    fireEvent.click(screen.getByTestId('timeline-range-all'))
    expect(setTimeRange).toHaveBeenLastCalledWith(null)
  })

  it('custom range reveals from/to fields that write the same filter', () => {
    const setTimeRange = vi.fn()
    draw({ setTimeRange })
    expect(screen.queryByTestId('timeline-time-since')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-range-custom'))
    fireEvent.change(screen.getByTestId('timeline-time-since'), { target: { value: '2026-01-02T03:04' } })
    expect(typeof (setTimeRange.mock.calls[0][0] as { since: number }).since).toBe('number')
  })

  it('shows the project span from events:span even with older rows unloaded', () => {
    draw({ hasMore: true, projectSpanMs: 25 * 3600_000 + 7 * 60_000 })
    expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session (25h 07m)')
    cleanup()
    // A range is not the whole session, whatever the project spans.
    draw({ projectSpanMs: 25 * 3600_000, timeRange: { since: Date.now() - 86_400_000 } })
    expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session')
  })

  it('without a project span, uses the loaded span only with nothing left to load', () => {
    draw()
    expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session (1h 30m)')
    cleanup()
    draw({ hasMore: true })
    expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session')
    cleanup()
    draw({ timeRange: { since: Date.now() - 86_400_000 } })
    expect(screen.getByTestId('timeline-range-all').textContent).toBe('Whole session')
    expect(formatSpan(25 * 3600_000 + 7 * 60_000)).toBe('25h 07m')
  })

  it('cannot zoom out past 100%, which is the whole span', () => {
    draw({ zoom: 1 })
    expect((screen.getByText('−').closest('button') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    draw({ zoom: 1.25 })
    expect((screen.getByText('−').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('zoom percentage is a read-only display; the controls call back', () => {
    const onZoomOut = vi.fn(); const onZoomIn = vi.fn(); const onResetZoom = vi.fn()
    draw({ zoom: 1.5, onZoomOut, onZoomIn, onResetZoom })
    const level = screen.getByTestId('timeline-zoom-level')
    expect(level.textContent).toBe('150%')
    expect(level.tagName).not.toBe('BUTTON')
    fireEvent.click(screen.getByText('−')); fireEvent.click(screen.getByText('+'))
    // Reset zoom is in 更多 (2026-11-14), with its `0` shortcut beside it.
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    fireEvent.click(screen.getByText('Reset zoom'))
    expect([onZoomOut, onZoomIn, onResetZoom].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('anchor is absent with no selection (no placeholder) and the event time with one', () => {
    draw()
    expect(screen.queryByTestId('timeline-anchor')).toBeNull()
    expect(screen.queryByText('Current anchor')).toBeNull()
    cleanup()
    draw({ anchorTs: Date.UTC(2026, 0, 2, 3, 4, 5) })
    expect(screen.getByTestId('timeline-anchor').textContent).toMatch(/\d{2}:\d{2}:05/)
  })

  // Reported from the real app: the Timeline said "Total 170" while the status
  // bar and the Activity status line said 171 for the same project. Both are
  // right — the Timeline drops RedLog's own housekeeping rows (spec 038), the
  // others count every recorded row — so the Timeline must not claim a total.
  it('names its count as what it loaded, never as the project total', () => {
    draw()
    expect(screen.getByTestId('timeline-range-status').textContent).toBe('3 events loaded')
    for (const locale of [en, zh] as Array<Record<string, string>>) {
      const own = locale['timeline.loadedEvents']
      expect(own).toBeTruthy()
      expect(own).not.toMatch(/total|總計/i)
      for (const other of ['statusBar.events', 'targets.events', 'timeline.events']) expect(own).not.toBe(locale[other])
    }
  })

  it('says how many of how many only while older events remain', () => {
    draw()
    cleanup()
    draw({ hasMore: true, loadedCount: 2, total: { state: 'ok', value: 250 } })
    const text = screen.getByTestId('timeline-range-status').textContent ?? ''
    expect(text).toBe('2 of 250 events · scroll back for older')
    expect(text).not.toContain('Total')
    expect(screen.getByText('Load more')).toBeTruthy()
  })

  it('a failed total offers retry', () => {
    const onRetryTotal = vi.fn()
    draw({ hasMore: true, total: { state: 'failed' }, onRetryTotal })
    fireEvent.click(screen.getByTestId('timeline-total-retry'))
    expect(onRetryTotal).toHaveBeenCalled()
  })

  // 2026-11-14: the Activity link is gone (the sidebar has it); the mode is
  // set once per project and lives in 更多.
  it('has no Activity link; the mode toggle in 更多 reports the mode', () => {
    const onModeChange = vi.fn()
    draw({ onModeChange })
    expect(screen.queryByTestId('timeline-open-activity')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    fireEvent.click(screen.getByTestId('timeline-mode-lanes'))
    expect(onModeChange).toHaveBeenCalledWith('lanes')
    // Choosing closes the menu; the harness's mode prop is still standard.
    expect(screen.queryByTestId('timeline-more-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    expect(screen.getByTestId('timeline-mode-standard').getAttribute('aria-checked')).toBe('true')
  })

  it('Search range in 更多 focuses the highlight input and closes the menu', () => {
    draw()
    const input = screen.getByTestId('timeline-search-input')
    expect(document.activeElement).not.toBe(input)
    fireEvent.click(screen.getByTestId('timeline-more-menu'))
    fireEvent.click(screen.getByTestId('timeline-search-toggle'))
    expect(document.activeElement).toBe(input)
    expect(screen.queryByTestId('timeline-more-panel')).toBeNull()
  })
})
