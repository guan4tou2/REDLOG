// @vitest-environment jsdom
//
// The disclosure model asks the main process one question: what does this
// engagement contain? On a fresh install the app mounts at the project picker,
// where the honest answer is "there is no engagement yet" — a null. Reading
// that null as "everything has been seen" is the one failure mode that hides
// the first-run screen from exactly the operator it was written for, and it is
// self-sealing: ALL_DISCLOSED makes `complete` true, which switches off the
// re-probe that would have corrected it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useVisibility } from '../src/renderer/src/hooks/useVisibility'
import { EMPTY_SIGNALS } from '../src/renderer/src/lib/visibility'

const PROJECT = { id: 'p1', name: 'engagement' }

let signals: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  signals = vi.fn(async () => null)
  ;(window as unknown as { redlog: unknown }).redlog = {
    visibility: { signals },
    events: { onNewBatch: () => () => {} }
  }
})
afterEach(cleanup)

describe('useVisibility', () => {
  it('asks again once a project opens, and shows the first-run screen for it', async () => {
    // Mount with no project, exactly as a fresh install does.
    const { result, rerender } = renderHook(
      ({ project }) => useVisibility(project, 'dashboard'),
      { initialProps: { project: null as typeof PROJECT | null } }
    )
    expect(signals).not.toHaveBeenCalled()
    expect(result.current.firstRunActive).toBe(false)

    signals.mockResolvedValue({ ...EMPTY_SIGNALS })
    rerender({ project: PROJECT })

    await waitFor(() => expect(result.current.firstRunActive).toBe(true))
    expect(result.current.visibility.firstRun).toBe(true)
  })

  it('does not treat "no project open" as every gate already unlocked', async () => {
    const { result } = renderHook(() => useVisibility(null, 'dashboard'))
    // Flush the microtasks a mount-time fetch would have resolved in, so this
    // is the settled answer and not the frame before it.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(signals).not.toHaveBeenCalled()
    expect(result.current.visSignals).toBeNull()
    expect(result.current.visibility.complete).toBe(false)
    expect(result.current.visibility.views.has('loot')).toBe(false)
  })

  it('still discloses everything when the probe itself fails', async () => {
    signals.mockRejectedValue(new Error('probe blew up'))
    const { result } = renderHook(() => useVisibility(PROJECT, 'dashboard'))
    await waitFor(() => expect(result.current.visibility.complete).toBe(true))
    // A failed probe must not be read as "nothing captured yet" either.
    expect(result.current.visibility.firstRun).toBe(false)
    expect(result.current.firstRunActive).toBe(false)
  })
})
