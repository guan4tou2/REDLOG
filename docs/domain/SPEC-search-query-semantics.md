# SPEC: Search Query Semantics

> Domain: Investigation / Evidence
> Invariant: Search filters (text, time range, agent type) compose at the SQL level. No filter is applied after LIMIT.
> Status: P1 — time range is currently applied client-side after a capped 200-row result, producing false negatives.

## Current (Broken) Pipeline

```
FTS MATCH query
  + agentType filter (SQL)
        ↓
  ORDER BY timestamp DESC
        ↓
  LIMIT 200
        ↓
  client-side time filter  ← false negatives here
```

## Correct Pipeline

```
FTS MATCH query
  + agentType filter (SQL)
  + since/before time predicate (SQL)
        ↓
  ORDER BY timestamp DESC, _row DESC
        ↓
  LIMIT
```

## Scenarios

### Scenario 1: Time range excludes newest — older match must be found

```
Given:
  200 events matching "nmap" with timestamp in [T+1000..T+1200] (recent)
  1 event matching "nmap" with timestamp = T (old, within range)
  time range = [T-100, T+100]
When:
  searchEvents("nmap", 200, { since: T-100, before: T+100 })
Then:
  result contains the old event at timestamp T
  result does NOT contain the 200 recent events
```

### Scenario 2: Both tiers respect time range

```
Given:
  chained shell event matching "curl" at T=1000
  logged scanner event matching "curl" at T=2000
  time range = [0, 1500]
When:
  searchEvents("curl", 200, { since: 0, before: 1500 })
Then:
  chained event included (T=1000 < 1500)
  logged event excluded (T=2000 > 1500)
```

### Scenario 3: agentType + timeRange + text compose correctly

```
Given:
  shell event matching "target" at T=500
  scanner event matching "target" at T=500
  shell event matching "target" at T=2000
When:
  searchEvents("target", 200, { agentType: "shell", since: 0, before: 1000 })
Then:
  only the shell event at T=500 is returned
```

### Scenario 4: Deterministic ordering with tie-breaking

```
Given:
  events A, B, C at same timestamp, all matching query
When:
  searchEvents(query)
Then:
  ordered by (timestamp DESC, insertion order DESC) — same semantics as queryEvents
```

### Scenario 5: Cast search has no time range (separate concern)

```
searchCasts does NOT accept since/before parameters.
Cast search time semantics are independent of event search.
```

## Acceptance Criteria

1. `searchEvents` accepts optional `since` and `before` timestamp params
2. Time predicates are SQL WHERE conditions, applied BEFORE LIMIT in both FTS arms
3. SearchPanel passes `sharedFilter.timeRange` to the backend call
4. SearchPanel removes client-side time filtering code
5. Existing agentType filtering continues to work
6. Cast search (`searchCasts`) is NOT modified
7. IPC handler, preload binding, and env.d.ts types updated

## Property

```
∀ event e matching query Q in time range [S, B]:
  e ∈ searchEvents(Q, ∞, { since: S, before: B })

i.e., no false negatives from LIMIT applied before time filter
```
