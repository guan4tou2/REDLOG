// @vitest-environment jsdom
//
// Stitch 05 lanes panel: a header outside the lane scroller that says how many
// lanes have events and which span the ruler covers, per-lane counts taken
// from loaded rows only, a way back to the standard view, and no bottom list
// in lanes mode (user decision 2026-11-08) while the selection still opens
// the detail pane and the two strips only the list could say stay reachable.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { TimelineEventLog } from '../src/renderer/src/components/timeline/TimelineEventLog'
import { countByLane, laneCountText, lanesHeaderText } from '../src/renderer/src/components/timeline/TimelineLanesHeader'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'
import { formatTime } from '../src/renderer/src/lib/time'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'
import type { RedLogEvent } from '../src/core/db/event-types'

const T0 = 1_700_000_000_000
const DETAIL_HANDLE = (en as Record<string, string>)['timeline.resizeDetailPanel']
const tr = (dict: Record<string, string>) => (k: string, v?: Record<string, string | number>): string =>
  (dict[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(v?.[n] ?? ''))
const tEn = tr(en as Record<string, string>)
const tZh = tr(zh as Record<string, string>)

afterEach(() => cleanup())

describe('lanes header wording', () => {
  const evs = [makeEvent('a', T0), makeEvent('b', T0 + 1000), makeEvent('c', T0 + 2000, 'dns')] as unknown as RedLogEvent[]

  it('counts loaded rows per lane and the lanes that have any', () => {
    const counts = countByLane(evs, [])
    expect(counts.get('shell')).toBe(2)
    expect(counts.get('dns')).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('says how many lanes have events, in both locales', () => {
    expect(lanesHeaderText({ activeLanes: 4, start: T0, end: T0 + 60_000, partial: false }, tZh).active).toBe('4 軌有事件')
    expect(lanesHeaderText({ activeLanes: 4, start: T0, end: T0 + 60_000, partial: false }, tEn).active).toBe('Lanes with events: 4')
  })

  it('names the span as the loaded range only while older pages are unfetched', () => {
    const from = formatTime(T0, { seconds: true }), to = formatTime(T0 + 60_000, { seconds: true })
    expect(lanesHeaderText({ activeLanes: 1, start: T0, end: T0 + 60_000, partial: false }, tZh).span).toBe(`時間範圍 ${from} ~ ${to}`)
    expect(lanesHeaderText({ activeLanes: 1, start: T0, end: T0 + 60_000, partial: true }, tZh).span).toBe(`已載入範圍 ${from} ~ ${to}`)
  })

  it('has no span when nothing is loaded', () => {
    expect(lanesHeaderText({ activeLanes: 0, start: 0, end: 0, partial: false }, tZh).span).toBeNull()
  })

  it('a lane count is a floor, not a total, while older pages are unfetched', () => {
    expect(laneCountText(42, false, tZh)).toBe('(42 筆)')
    expect(laneCountText(42, true, tZh)).toBe('(42+ 筆)')
    expect(laneCountText(42, true, tEn)).toBe('(42+)')
  })

  it('does not carry the prototype lane captions', () => {
    const all = JSON.stringify(zh)
    expect(all).not.toContain('規則引擎審計守護')
    expect(all).not.toContain('本地 LLM 助理即時策略反饋')
    expect(all).not.toContain('4 軌道活躍中')
  })
})

describe('the list in swim-lane mode', () => {
  let b: TimelineBridge
  const mount = (): void => {
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
  }
  beforeEach(() => {
    try { localStorage.clear() } catch { /* ignore */ }
    localStorage.setItem('redlog-locale', 'en')
  })

  describe('lanes', () => {
    beforeEach(() => {
      b = installTimelineBridge({ timelineMode: 'lanes' })
      b.queryPage.mockResolvedValue(page([makeEvent('e1', T0), makeEvent('e2', T0 + 1000), makeEvent('e3', T0 + 2000, 'dns')]))
    })

    it('draws the header outside the lane scroller, with the counts', async () => {
      mount()
      const header = await screen.findByTestId('timeline-lanes-header')
      expect(screen.getByTestId('timeline-lane-scroll').contains(header)).toBe(false)
      expect(screen.getByTestId('timeline-lanes-active').textContent).toBe('Lanes with events: 2')
      expect(screen.getByTestId('timeline-lanes-span').textContent).toMatch(/^Range \d{2}:\d{2}:\d{2}\S* ~ /)
      // Bands start collapsed; opening one lists its lanes with their counts.
      fireEvent.click(await screen.findByTestId('timeline-band-commands'))
      expect(screen.getByTestId('timeline-lane-shell').textContent).toContain('(2)')
    })

    it('keeps the label column as the scroller\'s first child', async () => {
      mount()
      await screen.findByTestId('timeline-lanes-header')
      const scroller = screen.getByTestId('timeline-lane-scroll')
      expect((scroller.firstElementChild as HTMLElement).classList.contains('cursor-grab')).toBe(false)
      expect(scroller.firstElementChild!.querySelector('[data-testid^="timeline-band-"]')).not.toBeNull()
    })

    it('hides the bottom list and its resize handle', async () => {
      mount()
      await screen.findByTestId('timeline-lanes-header')
      expect(screen.queryByTestId('timeline-log-resize')).toBeNull()
      expect(document.querySelector('[data-testid^="log-fold-"]')).toBeNull()
      expect(screen.queryAllByTestId('log-row-result')).toHaveLength(0)
    })

    it('still shows the bar for a selected dot, and opens the body on a double-click', async () => {
      mount()
      await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
      fireEvent.click(document.querySelector('[data-timeline-event]')!)
      await screen.findByTestId('timeline-detail-panel')
      expect(screen.queryByTitle(DETAIL_HANDLE)).toBeNull()
      fireEvent.doubleClick(document.querySelector('[data-timeline-event]')!)
      await waitFor(() => expect(screen.queryByTitle(DETAIL_HANDLE)).not.toBeNull())
    })

    it('opens an event it is sent to, with no list on screen', async () => {
      render(<I18nProvider><FilterProvider><TimelinePanel focusEventId="e1" /></FilterProvider></I18nProvider>)
      await waitFor(() => expect(screen.queryByTitle(DETAIL_HANDLE)).not.toBeNull())
      expect(screen.queryByTestId('timeline-log-resize')).toBeNull()
    })

    it('"back to standard" switches the mode and brings the list back', async () => {
      mount()
      fireEvent.click(await screen.findByTestId('timeline-lanes-collapse'))
      await waitFor(() => expect(screen.getByTestId('timeline-mode-standard').getAttribute('aria-pressed')).toBe('true'))
      expect(screen.queryByTestId('timeline-lanes-header')).toBeNull()
      expect(screen.queryByTestId('rail-count')).not.toBeNull()
    })
  })

  describe('standard', () => {
    it('shows the list and no lanes header', async () => {
      b = installTimelineBridge({ timelineMode: 'standard' })
      b.queryPage.mockResolvedValue(page([makeEvent('e1', T0)]))
      mount()
      await waitFor(() => expect(document.querySelector('[data-timeline-event]')).not.toBeNull())
      expect(screen.queryByTestId('rail-count')).not.toBeNull()
      expect(screen.queryByTestId('timeline-lanes-header')).toBeNull()
      // 2026-11-08: the track is one row sized to its content and the rail
      // takes the rest, so there is no split between them to drag.
      expect(screen.queryByTestId('timeline-log-resize')).toBeNull()
    })
  })
})

describe('the two strips only the list could say stay in lanes mode', () => {
  const ev = [makeEvent('x', T0)] as unknown as RedLogEvent[]
  const draw = (extra: Partial<Parameters<typeof TimelineEventLog>[0]>): void => {
    render(
      <TimelineEventLog
        events={ev} selectedId={null} detailOpen={false} pluginTypes={[]} showOperator={false}
        operatorLabel={(id) => id} titleOf={() => 'row-title'} amendSuffix={() => ''}
        amendCountOf={() => undefined} onSelect={vi.fn()} t={(k) => k} stripsOnly {...extra}
      />
    )
  }

  it('renders nothing when there is nothing to say', () => {
    draw({})
    expect(document.body.textContent).toBe('')
  })

  it('keeps the hidden-by-query toggle and the attribution-blind line, without any row', () => {
    const onToggleHidden = vi.fn()
    draw({ hiddenByQuery: 3, onToggleHidden, attributionBlind: true })
    fireEvent.click(screen.getByTestId('log-hidden-toggle'))
    expect(onToggleHidden).toHaveBeenCalled()
    expect(screen.getByTestId('log-attribution-blind')).toBeTruthy()
    expect(screen.queryByText('row-title')).toBeNull()
  })
})
