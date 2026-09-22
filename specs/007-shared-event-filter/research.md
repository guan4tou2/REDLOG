# Research: Shared Event Filter

## Decision: project scope remains authoritative

The renderer sends the operator's `inScopeOnly` choice. Main resolves the active
project's current targets and exclusions so a compromised or stale renderer
cannot substitute different scope semantics.

## Decision: filter events before projection

Search can page filtered events directly. Transcript blocks and HTTP flows need
relationship-aware pagination in later features, but their current bounded raw
event inputs can still be filtered before their caps. This removes the current
false-completeness defect without prematurely designing those projections.
