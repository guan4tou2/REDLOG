// @vitest-environment jsdom
// A read that fails must not be shown as a safe or empty answer: no green
// "scope OK" when the scope state could not be read, no "no targets" when
// the targets could not be loaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn(), toastDeferred: vi.fn() }))
vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({ filter: { targetId: null }, setFilter: vi.fn(), update: vi.fn() })
}))

import { useAppCounts } from '../src/renderer/src/lib/useAppCounts'
import { TargetView } from '../src/renderer/src/components/TargetView'

const bridge = (over: Record<string, unknown> = {}): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      getCount: vi.fn().mockResolvedValue(3),
      onNewBatch: () => () => {},
      aggregateTargets: vi.fn().mockResolvedValue([]),
      queryPage: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null })
    },
    loot: { getCount: vi.fn().mockResolvedValue(0) },
    chain: { length: vi.fn().mockResolvedValue(0) },
    scope: {
      getViolationCount: vi.fn().mockResolvedValue(0),
      isConfigured: vi.fn().mockResolvedValue(true)
    },
    config: { get: vi.fn().mockResolvedValue({ scope: { targets: ['10.0.0.1'], excludeTargets: [] } }) },
    targetContext: { get: vi.fn().mockResolvedValue(null), onChange: () => () => {}, set: vi.fn() },
    ...over
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('useAppCounts', () => {
  it('reports scope as unknown, not configured and clean, when it cannot be read — and recovers on retry', async () => {
    bridge()
    const scope = (window as unknown as { redlog: { scope: Record<string, ReturnType<typeof vi.fn>> } }).redlog.scope
    scope.getViolationCount.mockRejectedValueOnce(new Error('db'))
    scope.isConfigured.mockRejectedValueOnce(new Error('db'))
    const { result } = renderHook(() => useAppCounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.scopeUnknown).toBe(true)
    expect(result.current.scopeConfigured).toBe(false)
    await act(async () => { result.current.retry() })
    await waitFor(() => expect(result.current.scopeUnknown).toBe(false))
    expect(result.current.scopeConfigured).toBe(true)
  })
})

describe('TargetView', () => {
  it('says the targets could not be loaded, with a retry, instead of an empty project', async () => {
    const aggregateTargets = vi.fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue([{ target: '10.0.0.1', firstSeen: 1, lastSeen: 2, eventCount: 4 }])
    bridge()
    ;(window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events.aggregateTargets = aggregateTargets
    render(<TargetView onOpenInTimeline={() => {}} />)
    expect(await screen.findByTestId('targets-load-error')).not.toBeNull()
    expect(screen.queryByText('targets.empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(await screen.findByText('10.0.0.1')).not.toBeNull()
    expect(screen.queryByTestId('targets-load-error')).toBeNull()
  })

  it('shows scope as unknown when the rules cannot be read, never as in scope', async () => {
    bridge({ config: { get: vi.fn().mockRejectedValue(new Error('no config')) } })
    ;(window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events.aggregateTargets =
      vi.fn().mockResolvedValue([{ target: 'evil.example', firstSeen: 1, lastSeen: 2, eventCount: 1 }])
    render(<TargetView onOpenInTimeline={() => {}} />)
    expect(await screen.findByTestId('targets-scope-failed')).not.toBeNull()
  })
})
