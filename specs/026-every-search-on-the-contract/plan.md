# Implementation Plan: Every Search on the Query Contract

## Constitution Check

- **Canonical Domain Semantics**: one query interpretation for every search
  entry point but the plugin host, which Spec 027 removes.
- **Explicit Failure**: palette and API report failure and unparsable input
  distinctly from no matches.
- **Surface Truthfulness**: an empty query can no longer present the whole
  dataset as results.
- **Risk-Based Test-First Verification**: palette and API cases were RED
  first; the retired function's assertions are ported, not rewritten.

## Design

1. Palette: parse, then `runQuery`; track answered / failed / unparsable.
2. API: parse, then `executeEventQuery`; 400 and 500 paths.
3. Remove `events:search` (the palette was its only caller).
4. Port the two test files through a local helper; delete `searchEventsPage`.
5. Make the contract answer nothing for an empty query.
