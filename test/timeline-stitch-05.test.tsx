// @vitest-environment jsdom
//
// Stitch 05: the standard Timeline's list names its colours and says how a
// finished command ended, and the detail pane puts those numbers at the top.
// Each is shown only when the event carries it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TimelineEventInspector } from '../src/renderer/src/components/timeline/TimelineEventInspector'
import { TimelineEventLog } from '../src/renderer/src/components/timeline/TimelineEventLog'
import type { RedLogEvent } from '../src/core/db/event-types'

const ev = (id: string, agentType: string, data: Record<string, unknown>, timestamp = 1_700_000_000_000): RedLogEvent => ({
  id, timestamp, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: timestamp
} as RedLogEvent)

const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k} ${JSON.stringify(v)}` : k)

function drawLog(events: RedLogEvent[]): void {
  render(
    <TimelineEventLog
      events={events} selectedId={null} detailOpen={false} pluginTypes={[]} showOperator={false}
      operatorLabel={(id) => id} titleOf={(e) => String(e.data?.command ?? e.id)} amendSuffix={() => ''}
      amendCountOf={() => undefined} onSelect={vi.fn()} t={t}
    />
  )
}

function drawInspector(event: RedLogEvent, onOpenInActivity?: (id: string, ts: number) => void): void {
  render(
    <I18nProvider>
      <TimelineEventInspector
        event={event} pluginTypes={[]} tierChip={false} doNotExport={false} onToggleDoNotExport={vi.fn()}
        onAround={vi.fn()} operatorLabel={(id) => id} titleOf={(e) => String(e.data?.command ?? e.id)}
        allLoaded focusChainOn={false} showJson={false} lookup={() => undefined} onJump={vi.fn()}
        onSelect={vi.fn()} onResolve={vi.fn()} onAmend={vi.fn()} t={(k: string) => k}
        onStep={vi.fn()} canStepPrev canStepNext onOpenInActivity={onOpenInActivity}
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

describe('list rows', () => {
  it('says how a finished command ended, and nothing on rows that have no result', () => {
    drawLog([
      ev('a', 'shell', { subtype: 'command_end', command: 'ls', exit_code: 2, duration_sec: 1.5 }),
      ev('b', 'shell', { subtype: 'command_start', command: 'id' }, 1_700_000_001_000)
    ])
    const results = screen.getAllByTestId('log-row-result')
    expect(results).toHaveLength(1)
    expect(results[0].textContent).toContain('"code":2')
    expect(results[0].textContent).toContain('1.5s')
  })
})

describe('detail pane', () => {
  it('shows exit code, duration and pid at the top when the event has them', () => {
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
