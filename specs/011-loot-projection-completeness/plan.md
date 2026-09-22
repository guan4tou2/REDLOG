# Implementation Plan: Loot Projection Completeness

## Constitution Check

- Query Completeness: expose `hasMore` instead of implying a capped set is complete.
- Surface Truthfulness: separate failed, empty, partial and complete states.
- Canonical Domain Semantics: reuse shared EventFilter and event paging.
- Architectural Restraint: retain the current Loot projection and SQLite query path.

## Design

1. Query loot through the generic cursor-based event page contract.
2. Apply the shared event filter before the page limit.
3. Track the next cursor independently from render-window state.
4. Merge older pages by event ID and preserve state after failures.
5. Render completeness, Load Older and retry controls around the existing projection.
