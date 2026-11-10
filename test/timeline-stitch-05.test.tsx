// @vitest-environment jsdom
//
// Stitch 05: the standard Timeline's list names its colours and says how a
// finished command ended, and the bottom bar puts those numbers up front.
// Each is shown only when the event carries it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TimelineDetailBar } from '../src/renderer/src/components/timeline/TimelineDetailBar'
import { TimelineEventLog } from '../src/renderer/src/components/timeline/TimelineEventLog'
import type { RedLogEvent } from '../src/core/db/event-types'

const ev = (id: string, agentType: string, data: Record<string, unknown>, timestamp = 1_700_000_000_000): RedLogEvent => ({
  id, timestamp, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: timestamp
} as RedLogEvent)

const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k} ${JSON.stringify(v)}` : k)

function drawLog(events: RedLogEvent[], extra: Partial<Parameters<typeof TimelineEventLog>[0]> = {}): void {
  render(
    <TimelineEventLog
      events={events} selectedId={null} detailOpen={false} pluginTypes={[]} showOperator={false}
      operatorLabel={(id) => id} titleOf={(e) => String(e.data?.command ?? e.id)} amendSuffix={() => ''}
      amendCountOf={() => undefined} onSelect={vi.fn()} onOpen={vi.fn()} t={t}
      {...extra}
    />
  )
}

function drawInspector(event: RedLogEvent, onOpenInActivity?: (id: string, ts: number) => void): void {
  render(
    <I18nProvider>
      <TimelineDetailBar
        event={event} pluginTypes={[]} titleOf={(e) => String(e.data?.command ?? e.id)} t={(k: string) => k}
        onStep={vi.fn()} canStepPrev canStepNext onOpenInActivity={onOpenInActivity}
        bodyOpen={false} onToggleBody={vi.fn()} onOpenReader={vi.fn()}
      />
    </I18nProvider>
  )
}

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getNote: vi.fn(async () => null), setNote: vi.fn(async () => null) }
  }
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('card rail', () => {
  const shell = (id: string, ts: number, extra: Record<string, unknown> = {}): RedLogEvent =>
    ev(id, 'shell', { subtype: 'command_end', command: id, exit_code: 0, ...extra }, ts)

  it('says how a finished command ended, and nothing on cards that have no result', () => {
    drawLog([
      ev('a', 'shell', { subtype: 'command_end', command: 'ls', exit_code: 2, duration_sec: 1.5 }),
      ev('b', 'shell', { subtype: 'command_start', command: 'id' }, 1_700_000_001_000)
    ])
    const results = screen.getAllByTestId('rail-card-meta')
    expect(results).toHaveLength(1)
    expect(results[0].textContent).toContain('"code":2')
    expect(results[0].textContent).toContain('1.5s')
  })

  it('draws the events in the order given (oldest first) and carries no roving tab stop', () => {
    drawLog([shell('first', 1_000), shell('second', 2_000)])
    const cards = screen.getAllByTestId('rail-card')
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining('first'), expect.stringContaining('second')])
    expect(document.querySelector('[data-timeline-event]')).toBeNull()
  })

  it('header says "latest N of total" only when the window holds more than is shown', () => {
    drawLog([shell('a', 1_000)], { total: 120 })
    expect(screen.getByTestId('rail-count').textContent).toBe('timeline.rail.capped {"shown":1,"total":120}')
    cleanup()
    drawLog([shell('a', 1_000)], { total: 1 })
    expect(screen.getByTestId('rail-count').textContent).toBe('1')
  })

  it('the selected card expands with inline stdout once the selection is still; others and stdout-less cards do not', async () => {
    const withOut = shell('a', 1_000, { stdout: '5432/tcp open' })
    const other = shell('b', 2_000, { stdout: 'zzz' })
    drawLog([withOut, other], { selectedId: 'a' })
    // Not at once: growing the card would move the next one under a double-click.
    expect(screen.queryByTestId('rail-card-stdout')).toBeNull()
    await screen.findByTestId('rail-card-stdout')
    const out = screen.getAllByTestId('rail-card-stdout')
    expect(out).toHaveLength(1)
    expect(out[0].textContent).toContain('timeline.card.stdout')
    expect(out[0].textContent).toContain('5432/tcp open')
    cleanup()
    drawLog([shell('c', 1_000)], { selectedId: 'c' })
    await new Promise((r) => setTimeout(r, 450))
    expect(screen.queryByTestId('rail-card-stdout')).toBeNull()
  })

  it('a click selects (with its click count), a double-click or Enter opens, Space only selects', () => {
    const onSelect = vi.fn()
    const onOpen = vi.fn()
    const e = shell('a', 1_000)
    drawLog([e], { onSelect, onOpen })
    const card = screen.getByTestId('rail-card')
    fireEvent.click(card, { detail: 1 })
    expect(onSelect).toHaveBeenCalledWith(e, 1)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.doubleClick(card)
    expect(onOpen).toHaveBeenCalledWith(e, 'dblclick')
    onOpen.mockClear(); onSelect.mockClear()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(e, 'key')
    fireEvent.keyDown(card, { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith(e, 0)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('folds keep their status summary and open on click', () => {
    const parent = shell('p', 1_000)
    const kids = [1, 2, 3, 4].map((i) => ev(`k${i}`, 'scanner', { subtype: 'http_response', status: 404, url: `http://x/${i}`, _causes: ['p'] }, 2_000 + i))
    drawLog([parent, ...kids])
    const fold = screen.getByTestId('log-fold-p')
    expect(fold.textContent).toContain('404\u00d74')
    expect(screen.queryAllByTestId('rail-card')).toHaveLength(0)
    fireEvent.click(fold)
    expect(screen.getAllByTestId('rail-card')).toHaveLength(4)
  })

  it('an amended marker keeps its count on the card', () => {
    drawLog([shell('a', 1_000)], { amendCountOf: () => 2 })
    expect(screen.getByTestId('marker-amend-count').textContent).toContain('"count":2')
  })
})

describe('bottom bar facts', () => {
  it('shows exit code, duration and pid when the event has them', () => {
    drawInspector(ev('a', 'shell', { subtype: 'command_end', command: 'ls', exit_code: 3, duration_sec: 2, pid: 99 }))
    expect(screen.getByTestId('detail-exit').textContent).toBe('3')
    expect(document.body.textContent).toContain('2 s')
    expect(document.body.textContent).toContain('99')
  })

  it('shows none of them for an event without', () => {
    drawInspector(ev('a', 'shell', { subtype: 'command_start', command: 'ls' }))
    expect(screen.queryByTestId('detail-exit')).toBeNull()
  })
})

describe('from the Timeline to the activity log (Stitch 05)', () => {
  it('opens the event in the activity log, and offers it only when there is somewhere to go', () => {
    const open = vi.fn()
    const event = ev('evt-1', 'shell', { subtype: 'command_start', command: 'ls' })
    drawInspector(event, open)
    fireEvent.click(screen.getByTestId('detail-open-activity'))
    // Stitch 06: the time travels with the id, so the way back can re-focus it.
    expect(open).toHaveBeenCalledWith('evt-1', event.timestamp)
    cleanup()
    drawInspector(ev('evt-1', 'shell', { subtype: 'command_start', command: 'ls' }))
    expect(screen.queryByTestId('detail-open-activity')).toBeNull()
  })

  it('copies a reference that pastes back into search', async () => {
    const write = vi.fn(async () => true)
    ;(window as unknown as { redlog: Record<string, unknown> }).redlog.clipboard = { writeText: write }
    drawInspector(ev('evt-2', 'shell', { subtype: 'command_start', command: 'ls' }))
    fireEvent.click(screen.getByTestId('detail-copy-ref'))
    await waitFor(() => expect(write).toHaveBeenCalledWith('event:evt-2'))
  })
})
