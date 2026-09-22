# Implementation Plan: Search Result Integrity

## Technical Context

- Search combines paged SQLite/FTS event results and an independent `.cast` index.
- React currently converts rejected event queries into an unchanged visual state
  and converts rejected `.cast` queries into an empty array.
- Existing shared filters and cursor semantics from Spec 007 remain authoritative.

## Constitution Check

- Explicit Failure: rejected, empty, partial and successful states stay distinct.
- Surface Truthfulness: visible matches disclose a failed secondary source.
- Query Completeness: a failed next page does not claim completion.
- Architectural Restraint: keep state within the existing Search component.
- Risk-Based Verification: add observable renderer failures before implementation.

## Design

1. Track primary, secondary and next-page failures independently.
2. Clear prior-query rows when a new query begins so failures cannot leave stale
   matches presented under new text.
3. Render accessible failure and partial-result notices with retry actions.
4. Preserve the current query, shared filters, loaded rows and cursor as required.
5. Ignore failures belonging to superseded requests.

## Gate

Renderer failure tests, i18n parity, typecheck, full tests, build and the Search
desktop journey must pass before marking Verified.
