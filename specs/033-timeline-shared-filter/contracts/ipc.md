# Contract: Event IPC (renderer ↔ main)

Every handler below runs `withActiveScope`, so `inScopeOnly` and `hidePersonal`
take the active project's policy from main, not from the renderer. None of them
catches a query error: a failure reaches the renderer as a rejected promise
(Constitution VI).

With no active project, each one returns its empty shape. That shape is a guard,
never a result a view renders. Event views exist only while a project is open,
because App shows the project picker otherwise. A reply that lands after the
project closed arrives at an unmounted view, and the Timeline's generation
guard drops it.

## `events:queryPage` — changed

```ts
(opts: EventFilter & {
  limit?: number                 // default 200
  cursor?: string | null         // canonical keyset, opaque
  excludeHousekeeping?: boolean  // NEW
}) => Promise<{ items: RedLogEvent[]; hasMore: boolean; nextCursor: string | null }>
```

`EventFilter` gains `tier?: 'chained'`. `targetId` now compares
case-insensitively.

## `events:runQuery` — changed

```ts
(req: {
  parsed: ParsedQuery            // may carry the new `operator` condition
  filter?: EventFilter
  limit?: number
  cursor?: string | null
  excludeHousekeeping?: boolean  // NEW
}) => Promise<EventQueryResult>
```

Unchanged rule: empty text with no conditions answers an empty page.

## `events:count` — new

```ts
(req: {
  parsed?: ParsedQuery           // omitted: count what the filter admits
  filter?: EventFilter
  cursor?: string | null         // count strictly past this position: the same
                                 // boundary events:queryPage pages from when
                                 // given this cursor (its last page's nextCursor)
  excludeHousekeeping?: boolean
}) => Promise<number>
```

- With `parsed`, it counts what `events:runQuery` would page through from the
  same cursor.
- Without it, it counts what `events:queryPage` would page through.
- A `parsed` with neither text nor conditions counts 0, like the query.

## `events:matchIds` — new

```ts
(req: {
  ids: string[]                  // 1..1000 event ids
  parsed?: ParsedQuery           // omitted: filter only
  filter?: EventFilter
  excludeHousekeeping?: boolean
}) => Promise<string[]>          // the subset of `ids` that satisfy it, in input order
```

- More than 1,000 ids is rejected, not truncated. The caller chunks.
- An id that does not exist is simply not returned.

## `events:queryHttpFlowPage` — behaviour change only

Under `tier: 'chained'` it returns an empty page. HTTP flows exist only in the
logged tier, and the panel says so (research R2).

## Removed or no longer used by the Timeline

- `events:query` — the Timeline no longer calls it. It stays for its other
  callers.

## Preload and `env.d.ts`

`window.redlog.events.count` and `window.redlog.events.matchIds` are added. The
two changed request shapes are typed in `env.d.ts` from the core types, as the
existing entries are.
