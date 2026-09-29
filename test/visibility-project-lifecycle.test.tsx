// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useVisibility } from '../src/renderer/src/hooks/useVisibility'
import { EMPTY_SIGNALS, type VisibilitySignals } from '../src/renderer/src/lib/visibility'

afterEach(() => { cleanup(); localStorage.clear() })
const mature: VisibilitySignals = { ...EMPTY_SIGNALS, evidenceSeen: true, transcriptSeen: true }
function bridge(signals: ReturnType<typeof vi.fn>): void {
  Object.assign(window, { redlog: { visibility: { signals }, events: { onNewBatch: () => () => {} } } })
}
it('opens first-run when a project is created from the picker without reloading', async () => {
  const signals = vi.fn(async (): Promise<VisibilitySignals | null> => null)
  bridge(signals)
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => useVisibility(id ? { id, name: id } : null, 'dashboard'), { initialProps: { id: null } })
  await act(async () => {})
  signals.mockResolvedValue(EMPTY_SIGNALS)
  rerender({ id: 'new-project' })
  await waitFor(() => expect(result.current.firstRunActive).toBe(true))
})
it('ignores a previous project response and resets the first-run latch on switch', async () => {
  let finish!: (v: VisibilitySignals) => void
  bridge(vi.fn().mockImplementationOnce(() => new Promise(r => { finish = r })).mockResolvedValueOnce(EMPTY_SIGNALS).mockResolvedValueOnce(mature))
  const { result, rerender } = renderHook(({ id }) => useVisibility({ id, name: id }, 'dashboard'), { initialProps: { id: 'old' } })
  rerender({ id: 'new' })
  await waitFor(() => expect(result.current.firstRunActive).toBe(true))
  await act(async () => finish(mature))
  expect(result.current.visSignals).toEqual(EMPTY_SIGNALS)
  rerender({ id: 'mature' })
  await waitFor(() => expect(result.current.visSignals).toEqual(mature))
  expect(result.current.firstRunActive).toBe(false)
})
