// @vitest-environment jsdom
//
// Spec 074 T016 (US3): what the Timeline says about the project must not
// change with how much of it is loaded or which part of it the filter admits.
// Today both of these are derived from the loaded, filtered rows:
//
//  1. The paused-recording band is built from `system.recording_paused` and
//     `recording_resumed` rows among the loaded ones (`sessionBoundaries`,
//     `timelineSessionBands.ts`). Filter the page to the Shell type and those
//     system rows are not loaded, so a minute in which nothing was recorded
//     looks like a minute of silence from a quiet operator.
//  2. The effect count in the Inspector is `effectsById` over the loaded rows
//     (`Timeline.tsx:963`). A command with five effects, two of them loaded,
//     says "Effects (2)".
//
// Both are stated as the correct behaviour in `it.fails` and go green with
// Phase 5/6 (`intervals` and `cause_counts`, T068). Each has a pin beside it
// that shows the fixture reaches the surface, so the RED cases cannot pass or
// fail for the wrong reason.
//
// Where the truth comes from in (2): the store's answer is served here by
// `events.causalChain`, because that is the only call today that returns
// effects beyond the loaded rows. Phase 5 reads `cause_counts`; T068 replaces
// the fixture's source of the number and nothing else in the test.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
let filterApi: ReturnType<typeof useSharedFilter>
function Probe(): null { filterApi = useSharedFilter(); return null }
const mount = (): void => { render(<I18nProvider><FilterProvider><Probe /><TimelinePanel /></FilterProvider></I18nProvider>) }

describe('what the Timeline says about the project, under a filter and a partial load', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    try { localStorage.clear(); localStorage.setItem('redlog-locale', 'en') } catch { /* ignore */ }
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const system = (id: string, ts: number, subtype: string) => makeEvent(id, ts, 'system', { data: { subtype } })
  /** The whole project: three commands and a minute in which recording was paused. */
  const project = [
    makeEvent('s1', T0, 'shell', { data: { subtype: 'command_end', command: 'cmd s1' } }),
    system('p1', T0 + 10_000, 'recording_paused'),
    system('r1', T0 + 70_000, 'recording_resumed'),
    makeEvent('s2', T0 + 80_000, 'shell', { data: { subtype: 'command_end', command: 'cmd s2' } }),
    makeEvent('s3', T0 + 90_000, 'shell', { data: { subtype: 'command_end', command: 'cmd s3' } })
  ]
  /** The store answers a page the way the shared filter asks it. */
  const serve = (): void => {
    b.queryPage.mockImplementation(async (opts: { agentType?: string; cursor?: string | null }) =>
      opts.cursor ? new Promise(() => {}) : page(project.filter((e) => !opts.agentType || e.agentType === opts.agentType)))
  }
  const pausedBand = (): HTMLElement | null => screen.queryByText('⏸ paused')

  it('(pin) draws the paused-recording minute when the Timeline is unfiltered', async () => {
    serve()
    mount()
    await waitFor(() => expect(pausedBand()).not.toBeNull())
  })

  it.fails('keeps the paused-recording minute after the page is filtered to the Shell type', async () => {
    serve()
    mount()
    await waitFor(() => expect(pausedBand()).not.toBeNull())
    act(() => { filterApi.setAgentType('shell') })
    await waitFor(() => expect(b.queryPage).toHaveBeenLastCalledWith(expect.objectContaining({ agentType: 'shell' })))
    await act(async () => { await Promise.resolve() })
    expect(pausedBand(), 'the paused band after the Shell filter').not.toBeNull()
  })

  describe('the effects of one command', () => {
    /** `cause` has five effects in the store; the page holds two of them. */
    const cause = makeEvent('cause', T0, 'shell', { data: { subtype: 'command_end', command: 'cmd cause' } })
    const effect = (n: number, ts: number) => makeEvent(`fx${n}`, ts, 'shell', { data: { subtype: 'command_end', command: `cmd fx${n}`, _causes: ['cause'] } })
    const everything = [cause, ...[1, 2, 3, 4, 5].map((n) => effect(n, T0 + n * 1000))]
    const loaded = [cause, effect(1, T0 + 1000), effect(2, T0 + 2000)]
    const selectCause = async (): Promise<void> => {
      b.queryPage.mockImplementation(async (opts: { cursor?: string | null }) => opts.cursor ? new Promise(() => {}) : page(loaded, true, 'c1'))
      b.count.mockResolvedValue(everything.length)
      ;(window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events.causalChain = vi.fn(async () => ({
        anchorId: 'cause', anchorFound: true, events: everything,
        edges: everything.slice(1).map((e) => ({ causeId: 'cause', effectId: e.id })), unavailableCauseIds: [], truncated: false
      }))
      mount()
      const dot = await screen.findByRole('button', { name: /cmd cause/ })
      fireEvent.click(dot)
      // The detail bar opens on a click; the body, where the effects are, on a double click.
      fireEvent.doubleClick(dot)
    }
    const effectsLine = (): string => screen.getByText(/Effects \(/).textContent ?? ''

    it('(pin) counts the effects among the rows it has loaded', async () => {
      await selectCause()
      await waitFor(() => expect(effectsLine()).toMatch(/Effects \(2\)/))
    })

    it.fails('counts every effect the store has, not those that happen to be loaded', async () => {
      await selectCause()
      await waitFor(() => expect(screen.queryByText(/Effects \(/)).not.toBeNull())
      expect(effectsLine(), 'the effects line for a command with five effects, two loaded').toMatch(/Effects \(5\)/)
    })
  })
})
