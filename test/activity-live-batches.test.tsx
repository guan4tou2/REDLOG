// @vitest-environment jsdom
//
// Live capture must not re-run the Activity projection. A batch only counts
// toward the "new activity" button; the page is read again when the operator
// presses it. At 80k rows one read was 1.3–1.7 s of main-process time, so a
// read per batch is what a stalled app looks like.

import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => v ? `${k} ${JSON.stringify(v)}` : k }) }))

afterEach(() => cleanup())

it('counts batches toward the refresh button and reads the page only when pressed', async () => {
  const batches = new Set<(events: unknown[]) => void>()
  const page = { items: [], hasMore: false, nextCursor: null, totalGroups: 0, totalMatches: 0, snapshot: {} }
  const activityPage = vi.fn().mockResolvedValue(page)
  ;(window as unknown as { redlog: unknown }).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { activityPage, activityMembers: vi.fn(), onNewBatch: (cb: (events: unknown[]) => void) => { batches.add(cb); return () => { batches.delete(cb) } } }
  }
  const request = { parsed: { text: '', conditions: [], tokens: [] }, filter: {}, excludeHousekeeping: true }
  const { rerender } = render(<ActivityResults request={request as never} />)
  await vi.waitFor(() => expect(activityPage).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 40; i++) {
    await act(async () => { for (const cb of batches) cb([{}, {}]) })
    // A parent re-rendering on the same batch (its counts changed) hands an
    // equal request; that is not a new query either.
    rerender(<ActivityResults request={{ ...request, filter: {} } as never} />)
  }
  expect(activityPage).toHaveBeenCalledTimes(1)
  expect((await screen.findByTestId('activity-new-events')).textContent).toContain('"count":80')
  fireEvent.click(screen.getByTestId('activity-new-events'))
  await vi.waitFor(() => expect(activityPage).toHaveBeenCalledTimes(2))
})
