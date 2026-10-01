// @vitest-environment jsdom
//
// Reading a capture is reading a sequence: what ran before this, what came
// back after. The keyboard could already walk it — lane by lane — and nothing
// on screen said so, so an operator who opened the pane from the list had to
// close it, move down a row, and open the next one.
//
// These step the LIST's order, not the lane's. That is the order they were
// reading when they opened the pane, and it is deliberately different from
// what ← and → do: one follows a single producer through time, this follows
// time across producers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TimelineEventInspector } from '../src/renderer/src/components/timeline/TimelineEventInspector'
import type { RedLogEvent } from '../src/core/db/event-types'

const ev = (id: string): RedLogEvent => ({
  id, timestamp: 1_700_000_000_000, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType: 'shell', hostname: 'h', sourceIP: null, targetId: null,
  data: { subtype: 'command_start', command: `cmd-${id}` }, createdAt: 1
} as RedLogEvent)

function draw(over: Partial<Parameters<typeof TimelineEventInspector>[0]> = {}): ReturnType<typeof vi.fn> {
  const onStep = vi.fn()
  render(
    <I18nProvider>
      <TimelineEventInspector
        event={ev('a')}
        pluginTypes={[]}
        tierChip={false}
        doNotExport={false}
        onToggleDoNotExport={vi.fn()}
        onAround={vi.fn()}
        operatorLabel={(id) => id}
        titleOf={(e) => String(e.data?.command ?? e.id)}
        allLoaded
        focusChainOn={false}
        showJson={false}
        lookup={() => undefined}
        onJump={vi.fn()}
        onSelect={vi.fn()}
        onResolve={vi.fn()}
        onAmend={vi.fn()}
        t={(k: string) => k}
        onStep={onStep}
        canStepPrev
        canStepNext
        {...over}
      />
    </I18nProvider>
  )
  return onStep
}

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'zh-TW')
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getNote: vi.fn(async () => null), setNote: vi.fn(async () => null) }
  }
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('stepping through the list from the detail pane', () => {
  it('moves back and forward', () => {
    const onStep = draw()
    fireEvent.click(screen.getByTestId('detail-step-prev'))
    expect(onStep).toHaveBeenCalledWith(-1)
    fireEvent.click(screen.getByTestId('detail-step-next'))
    expect(onStep).toHaveBeenCalledWith(1)
  })

  it('disables the end it cannot go past, rather than hiding it', () => {
    // A control that vanishes at the boundary makes the operator hunt for a
    // button that was there a second ago. Disabled says "this is the end".
    draw({ canStepPrev: false })
    expect((screen.getByTestId('detail-step-prev') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('detail-step-next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not fire when it is at the end', () => {
    const onStep = draw({ canStepNext: false })
    fireEvent.click(screen.getByTestId('detail-step-next'))
    expect(onStep).not.toHaveBeenCalled()
  })

  it('is absent when there is no list to walk', () => {
    draw({ onStep: undefined })
    expect(screen.queryByTestId('detail-step-prev')).toBeNull()
  })

  it('names both directions for a screen reader', () => {
    draw()
    expect(screen.getByTestId('detail-step-prev').getAttribute('aria-label')).toBeTruthy()
    expect(screen.getByTestId('detail-step-next').getAttribute('aria-label')).toBeTruthy()
  })
})
