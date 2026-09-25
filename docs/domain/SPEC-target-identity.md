# SPEC: Target Identity

> Domain: Engagement / Evidence
> Invariant: Every target-oriented query MUST use the same canonical target identity semantics.
> Status: Implemented — canonical identity and active-target fallback share the ingest boundary; every target filter compares case-insensitively through one helper (Spec 038).

## Canonical Definition

**Target identity** is the `target_id` column on `events` / `events_logged` tables.

- `target_id` is set at insert time by the ingest pipeline (shell target extraction, HTTP host, CDP URL, connection monitor, API events).
- `data.detectedTarget` is an **observation metadata** field stamped by the shell enrichment step. It is a subset of `target_id` — never set without `target_id` also being set, but `target_id` can be set without `detectedTarget` (HTTP/scanner/browser events).
- `data.host` is an HTTP/DNS transport field, not a target identity.
- No filter matches an observation field as the target: `data.host`,
  `remote_addr`, `dest_ip`, `dest_host`, `detectedTarget`, `data.target`. The
  Timeline did until Spec 038; its target is now the shared filter's, which is
  `target_id`.
- `engagement.activeTarget` is operator context, not an observation. Canonical
  ingest uses it only for shell, marker and screenshot rows when neither an
  explicit `targetId` nor enrichment found a target. It never overwrites an
  observed identity or labels unrelated system/health events.

```
target_id ⊇ detectedTarget
target_id ⊇ data.host (for target-bearing events)
```

Target assignment precedence at ingest is:

```
explicit producer target > observed/enriched target > active-target fallback > null
```

Changing or clearing the active target appends `system.active_target_changed`;
existing rows are never re-attributed.

## Normalization

- Hostname: case-insensitive. Stored as-is; the aggregate groups `LOWER(target_id)`,
  and every filter compares with `COLLATE NOCASE` through one helper,
  `targetPredicate` in `src/core/db/event-queries.ts`. NOCASE folds ASCII,
  which is what hostnames (IDN as punycode) and addresses are.
- IPv4: dotted-quad, no leading zeros (e.g., `10.0.0.1`)
- IPv6: not normalized yet (stored as-is) — future: RFC 5952 canonical form
- CIDR: `target_id` may contain a bare IP; CIDR matching is Scope's job, not Target identity's

## Invariant

```
∀ target T:
  aggregateTargets().find(t => t.target ≈ T).eventCount
  ==
  countEvents({ filter: { targetId: T }, excludeHousekeeping: true })
```

`≈` is the case-insensitive match the aggregate groups by. In words: the
Targets page count, its list and the Timeline's total must agree, because they
key on the same identity, including for a target recorded in two casings, and
leave out the same rows: RedLog's own housekeeping (`HOUSEKEEPING_SQL`). The
active-target fallback stamps every shell row, so a terminal opening or the
hook sourcing itself can carry a target; those rows are not what happened to
it (Spec 038). A read without `excludeHousekeeping`, such as an export, still
sees them.

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
And when:
  queryEvents({ targetId: 'EXAMPLE.com' }), or the shared filter's target
  set from the Targets page
Then:
  both events, 2 — the count the aggregate showed
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

Scenario 5 bounded `hostCausalChain`, which #143 removed with its only
channel; nothing called it.

## Acceptance Criteria

1. `aggregateTargets()` groups by `target_id` column, NOT `json_extract(data, '$.detectedTarget')`
2. Case-insensitive grouping: `LOWER(target_id)` in GROUP BY
3. The aggregate count, the Targets list and the Timeline's total agree for the same target, housekeeping rows counted by none of them (Spec 038)
4. Events with `target_id` but no `detectedTarget` are included in aggregates
5. No change to Scope matchers in this fix (separate P1)
6. Active-target context is project-scoped and cleared from runtime on project close
7. Explicit or detected targets override active-target context
8. Every target filter compares case-insensitively through `targetPredicate`, so the aggregate and a filter agree for a target recorded in two casings (Spec 038)

## Property

```
∀ target T in aggregateTargets():
  T.eventCount == COUNT(events WHERE target_id = T COLLATE NOCASE AND NOT housekeeping)
               + COUNT(events_logged WHERE target_id = T COLLATE NOCASE AND NOT housekeeping)
```
