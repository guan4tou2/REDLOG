# Implementation Plan: One Secret Pattern Table

## Constitution Check

- **Canonical Domain Semantics**: one definition per secret shape.
- **Evidence Integrity**: loot match order preserved, because loot events are
  chained; stored flag loot untouched.
- **Risk-Based Test-First Verification**: behaviour captured as a golden corpus
  from the pre-refactor code before any change; the flag removal and the
  structural guards were RED first.
- **Architectural Restraint**: one new module, holding data the two existing
  modules already had.

## Design

1. Capture a golden corpus of redaction output and loot matches from the
   existing code.
2. Move every regex literal verbatim — by program, not by hand — into
   `secret-patterns.ts`, merging only the one shape whose literal was identical
   in both consumers.
3. Express each consumer's coverage as an ordered list of shape ids in the same
   file; move the transcript prefilter beside the redaction list.
4. Point both consumers at the table; drop the flag pattern.
5. Add structural guards.
