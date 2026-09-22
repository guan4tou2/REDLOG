# Research: Loot Projection Completeness

## Finding: render windowing is not evidence pagination

The current infinite-scroll helper limits mounted rows after a fixed backend
query. It improves rendering cost but cannot reveal evidence outside that query.

## Decision: reuse the generic event page contract

Loot events do not require a special aggregation boundary. The existing event
cursor already gives stable ordering, shared filtering and cross-tier behavior.

## Decision: keep local projection controls local

Loot type chips and preview deduplication transform loaded evidence for reading.
They do not change which evidence pages are eligible, so completeness must stay
visible while either control is active.
