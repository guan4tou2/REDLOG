# SPEC: Export Event Selection

> Domain: Evidence / Engagement / Handoff
> Invariant: Export selection must operate across ALL persisted event tiers.
> Status: P0 — `queryScopeFilteredEvents` currently only queries `events` table, missing entire `events_logged` tier.

## Domain Concepts

| Concept | Definition |
|---------|-----------|
| Chained Event | `events` table — hash chain + signature |
| Logged Event | `events_logged` table — high-volume, no chain |
| Scope Target | Target within engagement authorization |
| Personal Domain | Operator's personal traffic — always excluded from export |
| Do-Not-Export | Events explicitly excluded by policy |
| Export Selection | The set of events included in an export operation |

## Invariant

```
Export operates on the complete persisted event population
(events ∪ events_logged) unless policy explicitly excludes an event.
```

## Scenarios

### Scenario 1: Both tiers included

```
Given:
  chained shell:command_end event A targeting 10.0.0.1
  logged scanner:http_response event B targeting 10.0.0.1
  scope targets = [10.0.0.1]
When:
  queryScopeFilteredEvents(scopeTargets)
Then:
  A included
  B included
  result.events contains both A and B
```

### Scenario 2: Out-of-scope filtering applies to both tiers

```
Given:
  chained event A targeting 10.0.0.1 (in scope)
  logged event B targeting 192.168.1.1 (out of scope)
  scope targets = [10.0.0.1]
When:
  queryScopeFilteredEvents(scopeTargets)
Then:
  A included
  B excluded
```

### Scenario 3: No-target whitelist applies to both tiers

```
Given:
  chained marker event (no target_id) — whitelisted
  chained clipboard event (no target_id) — not whitelisted
When:
  queryScopeFilteredEvents(scopeTargets)
Then:
  marker included
  clipboard excluded
```

### Scenario 4: Empty scope returns all eligible events from both tiers

```
Given:
  chained event A
  logged event B
  scope targets = [] (empty — no scope filtering)
When:
  queryScopeFilteredEvents([])
Then:
  both A and B included (minus excluded agent_types)
```

### Scenario 5: Excluded agent_types filtered from both tiers

```
Given:
  logged system:process_monitor_saturated event (excluded type)
  scope targets = []
When:
  queryScopeFilteredEvents([])
Then:
  system event excluded
```

## Acceptance Criteria

1. `queryScopeFilteredEvents` queries BOTH `events` AND `events_logged` tables
2. Scope filtering (target matching) applies identically to both tiers
3. Agent type whitelist/blacklist applies identically to both tiers
4. Result ordering is by timestamp DESC across both tiers
5. Callers (`data-export.ts` NDJSON and scope-filtered JSON) receive events from both tiers without code changes

## Property

```
∀ export preset ∈ {sharing, forensic, ...}:
  previewCount(preset) == actualExportCount(preset)

∀ event e ∈ (events ∪ events_logged):
  eligible(e, scope) ↔ e ∈ queryScopeFilteredEvents(scope).events
```
