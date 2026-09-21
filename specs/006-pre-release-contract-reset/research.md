# Research: Compatibility Inventory

## Decision: Remove unreleased version contracts

RedLog has no released compatibility commitment. API aliases, migration reads,
legacy event shapes and production test shims reduce confidence in the contract
that will ship, so they are removed and current callers migrate directly.

## Decision: Keep operational resilience

Network fallbacks, offline spool, bounded parser defaults and the bundled
starter-pack fallback address current runtime failure. They do not translate an
old contract and remain in scope as required reliability behavior.

## Decision: Preserve history as prose only

Changelogs and audit documents may name removed behavior. Current setup and
architecture documents describe only the current contract.
