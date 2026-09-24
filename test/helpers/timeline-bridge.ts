import { vi, type Mock } from 'vitest'

// A bridge for mounting TimelinePanel in jsdom (spec 038). The event reads
// the Timeline makes are vi.fn()s a test can script and inspect; every other
// namespace the panel or its children touch answers harmlessly: `on*`
// subscriptions return an unsubscribe, anything else resolves to null.

type Ev = Record<string, unknown> & { id: string; timestamp: number; agentType: string }

export function makeEvent(id: string, timestamp: number, agentType = 'shell', extra: Partial<Ev> = {}): Ev {
  return {
    id, timestamp, agentType,
    engagementId: 'eng', sessionId: 's', operatorId: 'op-1', hostname: 'h', sourceIP: null,
    targetId: null, data: { subtype: agentType === 'shell' ? 'command_end' : 'event', command: `cmd ${id}` },
    hash: 'a'.repeat(64), createdAt: timestamp, tier: 'chained',
    ...extra
  }
}

export interface Page { items: Ev[]; hasMore: boolean; nextCursor: string | null }

export interface TimelineBridge {
  queryPage: Mock
  count: Mock
  matchIds: Mock
  runQuery: Mock
  query: Mock
  getById: Mock
  /** Push a live batch, as main's events:new-batch would. */
  emitBatch: (events: Ev[]) => void
}

export const page = (items: Ev[], hasMore = false, nextCursor: string | null = null): Page =>
  ({ items, hasMore, nextCursor })

export function installTimelineBridge(): TimelineBridge {
  const batchListeners = new Set<(events: Ev[]) => void>()
  const queryPage = vi.fn(async () => page([]))
  const count = vi.fn(async () => 0)
  const matchIds = vi.fn(async (req: { ids: string[] }) => req.ids)
  const runQuery = vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null }))
  const query = vi.fn(async () => [])
  const getById = vi.fn(async () => [])
  const events = {
    queryPage, count, matchIds, runQuery, query, getById,
    onNewBatch: (cb: (events: Ev[]) => void) => { batchListeners.add(cb); return () => batchListeners.delete(cb) },
    aggregateTargets: async () => [],
    distinctAgentTypes: async () => [],
    causalChain: async () => ({ anchorFound: false, events: [], edges: [], truncated: false, unavailable: 0 }),
    isDoNotExport: async () => false,
    toggleDoNotExport: async () => false
  }
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => prop.startsWith('on')
      ? () => () => {}
      : async () => null
  })
  const known: Record<string, unknown> = {
    platform: 'darwin',
    events,
    config: { get: async () => ({ scope: { targets: [], excludeTargets: [], personalDomains: [] } }), save: async () => true },
    project: { active: async () => ({ id: 'p1', name: 'Proj' }) },
    operators: { list: async () => [] },
    plugins: { eventTypes: async () => [] }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  return {
    queryPage, count, matchIds, runQuery, query, getById,
    emitBatch: (evts) => { for (const cb of batchListeners) cb(evts) }
  }
}

/** A promise the test resolves later, to hold a reply in flight. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
