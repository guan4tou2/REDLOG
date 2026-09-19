# SPEC: Target Identity

> Domain: Engagement / Evidence
> Invariant: Every target-oriented query MUST use the same canonical target identity semantics.
> Status: P0 — `aggregateTargets` keys on `data.detectedTarget` (JSON), detail query keys on `target_id` (column). Can diverge.

## Canonical Definition

**Target identity** is the `target_id` column on `events` / `events_logged` tables.

- `target_id` is set at insert time by the ingest pipeline (shell target extraction, HTTP host, CDP URL, connection monitor, API events).
- `data.detectedTarget` is an **observation metadata** field stamped by the shell enrichment step. It is a subset of `target_id` — never set without `target_id` also being set, but `target_id` can be set without `detectedTarget` (HTTP/scanner/browser events).
- `data.host` is an HTTP/DNS transport field, not a target identity.

```
target_id ⊇ detectedTarget
target_id ⊇ data.host (for target-bearing events)
```

## Normalization

- Hostname: case-insensitive (stored as-is, compared lowercased)
- IPv4: dotted-quad, no leading zeros (e.g., `10.0.0.1`)
- IPv6: not normalized yet (stored as-is) — future: RFC 5952 canonical form
- CIDR: `target_id` may contain a bare IP; CIDR matching is Scope's job, not Target identity's

## Invariant

```
∀ target T:
  aggregateTargets().find(t => t.target === T).eventCount
  ==
  queryEvents({ targetId: T }).length  (uncapped)
```

In words: the aggregate count and the detail query must agree because they key on the same identity.

## Scenarios

### Scenario 1: Aggregate and detail agree on count

```
Given:
  3 shell:command_end events with target_id = '10.0.0.1'
  2 scanner:http_response events with target_id = '10.0.0.1' (no detectedTarget)
When:
  aggregateTargets() for '10.0.0.1'
  queryEvents({ targetId: '10.0.0.1' })
Then:
  aggregate.eventCount == 5
  detail.length == 5
```

### Scenario 2: Events with target_id but no detectedTarget

```
Given:
  1 scanner:http_response event with target_id = '10.0.0.1', no data.detectedTarget
When:
  aggregateTargets()
Then:
  '10.0.0.1' appears in result with eventCount >= 1
  (Previously invisible because aggregateTargets only read detectedTarget)
```

### Scenario 3: Case-insensitive grouping

```
Given:
  1 event with target_id = 'Example.COM'
  1 event with target_id = 'example.com'
When:
  aggregateTargets()
Then:
  grouped as 1 target, eventCount = 2
  displayed form is one of the original casing variants
```

### Scenario 4: Null target_id excluded

```
Given:
  1 marker event with target_id = NULL
  1 shell event with target_id = '10.0.0.1'
When:
  aggregateTargets()
Then:
  only '10.0.0.1' in result (marker excluded — it has no target identity)
```

### Scenario 5: hostCausalChain consistency

```
Given:
  target T with events in both tiers
When:
  hostCausalChain(T).eventCount
Then:
  >= aggregateTargets().find(t => t.target === T).eventCount
  (hostCausalChain may match broader — data.host, detectedTarget — but never narrower)
```

## Acceptance Criteria

1. `aggregateTargets()` groups by `target_id` column, NOT `json_extract(data, '$.detectedTarget')`
2. Case-insensitive grouping: `LOWER(target_id)` in GROUP BY
3. Aggregate count and `queryEvents({ targetId })` agree for the same target
4. Events with `target_id` but no `detectedTarget` are included in aggregates
5. `hostCausalChain` eventCount is >= aggregate eventCount (broader match is OK)
6. No change to Scope matchers in this fix (separate P1)

## Property

```
∀ target T in aggregateTargets():
  T.eventCount == COUNT(events WHERE target_id = T) + COUNT(events_logged WHERE target_id = T)
```
