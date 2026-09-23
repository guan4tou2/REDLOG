# Implementation Plan: Architecture Gate

## Canonical module interface

`scripts/verify-architecture.mjs` (CI: `npm run verify:architecture`),
`scripts/architecture-allowlist.json` (`"file#name": "reason"`).

## Constitution Check

- **III Canonical modules / VII Architectural Restraint**: enforced by CI
  instead of review; the gate adds no runtime code.
- **VIII Risk-Based Test-First**: tests now exercise the shipped path.
- **Explicit Failure**: a stale allowlist entry fails, so the list only shrinks.

## Design

1. Parse `src/`, `test/`, `e2e/` with the TypeScript AST; count identifier
   names per file; classify each top-level export of `src/`.
2. Act on the 55 findings on main after #143:
   - remove unused code (capture-health helpers, do-not-export mark/unmark,
     startHost/startFileWatcher/startProcessMonitor, hud/timeline helpers,
     the event type guards and the type module only they used,
     `credentialFromClipboard` and its never-produced `clipboard_secret` kind,
     `queryScopeFilteredEvents`, `isInScope`, `formatIso`, `DAY_ONE`,
     `confirmIrreversible` (`confirm(…, true)` is the same level));
   - route production through the tested function: `planTranscriptEmit`,
     `foldAllMarkers`; move chain tests to `verifyChainFullAsync` and drop the
     sync variant; drop `buildCursorWhere` (superseded by the per-arm builder);
   - rename test introspection to `_` seams (`_listCommandTags`,
     `_listExternalLootPatterns`, `_listExternalTargetExtractors`);
   - fix the raw-store cache;
   - allowlist the rest with reasons.
