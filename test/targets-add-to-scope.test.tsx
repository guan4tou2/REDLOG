// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { ToastContainer, UNDO_MS } from '../src/renderer/src/components/Toast'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

// "Add to scope" on the Targets page read the whole config when the button was
// pressed and wrote the whole config back when the undo window closed, eight
// seconds later. A project switch in between put A's settings into B, and two
// targets added inside the window overwrote each other. The page now says which
// project it meant and which one target to add; the merge is the main
// process's, against the config as it is when the window closes.

const T0 = 1_700_000_000_000

interface Bridge { addTarget: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }

function install(addTarget: (t: string, o?: { expectProjectId?: string }) => Promise<boolean>): Bridge {
  installTimelineBridge()
  const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
  r.events.aggregateTargets = async () => [
    { target: 'a.example', eventCount: 1, firstSeen: T0 - 5000, lastSeen: T0 },
    { target: 'b.example', eventCount: 1, firstSeen: T0 - 5000, lastSeen: T0 }
  ]
  const save = vi.fn(async () => true)
  const add = vi.fn(addTarget)
  r.config = { get: async () => ({ engagement: { id: 'eng-A' }, scope: { targets: ['10.0.0.1'], excludeTargets: [] } }), save }
  r.scope = { ...r.scope, isConfigured: async () => true, addTarget: add }
  return { addTarget: add, save }
}

const mountPage = (): void => {
  render(<I18nProvider><FilterProvider><ToastContainer /><TargetView /></FilterProvider></I18nProvider>)
}

describe('adding a target to the scope from the Targets page', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('sends one target and the project it was pressed in, after the undo window', async () => {
    const b = install(async () => true)
    mountPage()
    const buttons = await screen.findAllByRole('button', { name: /加入範圍|Add to scope/i })
    await act(async () => { fireEvent.click(buttons[0]) })

    expect(b.addTarget, 'written before the undo window closed').not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 50) })
    await waitFor(() => expect(b.addTarget).toHaveBeenCalledTimes(1))
    expect(b.addTarget).toHaveBeenCalledWith('a.example', { expectProjectId: 'eng-A' })
    // The page no longer writes the config itself.
    expect(b.save).not.toHaveBeenCalled()
  })

  it('two targets added inside one window are two single-target requests, not two whole configs', async () => {
    const b = install(async () => true)
    mountPage()
    const buttons = await screen.findAllByRole('button', { name: /加入範圍|Add to scope/i })
    await act(async () => { fireEvent.click(buttons[0]) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /加入範圍|Add to scope/i })[0]) })
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 50) })
    await waitFor(() => expect(b.addTarget).toHaveBeenCalledTimes(2))
    expect(b.addTarget.mock.calls.map((c) => c[0]).sort()).toEqual(['a.example', 'b.example'])
    expect(b.save).not.toHaveBeenCalled()
  })

  it('takes the chip back and says so when the project changed or the write failed', async () => {
    const b = install(async () => false)
    mountPage()
    const buttons = await screen.findAllByRole('button', { name: /加入範圍|Add to scope/i })
    await act(async () => { fireEvent.click(buttons[0]) })
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 50) })
    await waitFor(() => expect(b.addTarget).toHaveBeenCalled())
    // Out of scope again, and an error toast instead of a silent success.
    expect(await screen.findByText(/無法將 a\.example 加入範圍|Could not add a\.example to scope/)).not.toBeNull()
    expect(screen.getAllByRole('button', { name: /加入範圍|Add to scope/i }).length).toBe(2)
  })
})
