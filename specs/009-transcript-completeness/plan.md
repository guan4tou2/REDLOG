# Implementation Plan: Transcript Completeness

## Technical Context

- Transcript projects multiple event types into paired blocks.
- Current reads are capped arrays with no completeness signal.
- The database already has a canonical two-tier opaque cursor primitive.
- Shared event predicates from Spec 007 must remain before pagination.

## Constitution Check

- Query Completeness: every bounded bucket exposes `hasMore` and a cursor.
- Surface Truthfulness: recent subset, complete, empty and failed are distinct.
- Canonical Domain Semantics: reuse canonical event ordering and shared filters.
- Explicit Failure: page rejection preserves retry context.
- Risk-Based Verification: cursor and renderer contracts begin as failing tests.

## Design

1. Add a general filtered event-page query using the canonical two-tier cursor.
2. Expose it through typed IPC and preload.
3. Track page state per Transcript event-type bucket.
4. Merge unique events and rebuild blocks after every page.
5. Show recent-subset and failure states; mark copied Markdown when partial.

## Gate

Cursor counterexamples, renderer contracts, typecheck, full tests, build and the
Transcript Electron journey must pass before marking Verified.
