// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelineToolbar, formatSpan } from '../src/renderer/src/components/timeline/TimelineToolbar'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'

type Props = Parameters<typeof TimelineToolbar>[0]

function Harness(over: Partial<Props>): JSX.Element {
  const { t } = useI18n()
  const props: Props = {
    t, timeRange: null, setTimeRange: vi.fn(), hasMore: false, loadedCount: 3, loadedSpanMs: 90 * 60_000, projectSpanMs: null,
    total: { state: 'ok', value: 3 }, onRetryTotal: vi.fn(), onLoadMore: vi.fn(),
    zoom: 1, onZoomOut: vi.fn(), onZoomIn: vi.fn(), onResetZoom: vi.fn(), anchorTs: null,
    mode: 'standard', onModeChange: vi.fn(), onOpenActivity: vi.fn(),
    filterQuery: '', onFilterQueryChange: vi.fn(), searchInputRef: createRef<HTMLInputElement>(),
    onHelp: vi.fn(), moreMenu: <span data-testid="more-slot" />, followBadge: <span data-testid="follow-slot" />,
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
    fireEvent.click(screen.getByText('Reset zoom'))
    expect([onZoomOut, onZoomIn, onResetZoom].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('anchor is a dash with no selection and the event time with one', () => {
    draw()
    expect(screen.getByTestId('timeline-anchor').textContent).toBe('—')
    cleanup()
    draw({ anchorTs: Date.UTC(2026, 0, 2, 3, 4, 5) })
    expect(screen.getByTestId('timeline-anchor').textContent).toMatch(/\d{2}:\d{2}:05/)
  })

  it('says Total only when nothing older remains', () => {
    draw()
    expect(screen.getByTestId('timeline-range-status').textContent).toBe('Total 3 events')
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

  it('Activity link calls openActivity; mode toggle reports the mode', () => {
    const onOpenActivity = vi.fn(); const onModeChange = vi.fn()
    draw({ onOpenActivity, onModeChange })
    fireEvent.click(screen.getByTestId('timeline-open-activity'))
    expect(onOpenActivity).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('timeline-mode-lanes'))
    expect(onModeChange).toHaveBeenCalledWith('lanes')
    expect(screen.getByTestId('timeline-mode-standard').getAttribute('aria-pressed')).toBe('true')
  })

  it('Search range focuses the highlight input', () => {
    draw()
    const input = screen.getByTestId('timeline-search-input')
    expect(document.activeElement).not.toBe(input)
    fireEvent.click(screen.getByTestId('timeline-search-toggle'))
    expect(document.activeElement).toBe(input)
  })
})
