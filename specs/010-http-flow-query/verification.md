# Verification: HTTP Flow Query

**Status**: Verified
**Date**: 2026-09-22

## Requirements trace

- SQLite first pages flow heads by request start and opaque `(start time, flow id)`
  cursor, then fetches every captured request/response member for those flows.
- Target, time and canonical scope predicates select flow heads before `LIMIT`.
- HTTP History no longer requests a capped 5,000-row event array.
- Activity, Every Request and Sitemap consume one merged, deduplicated flow set.
- Complete/recent-subset, Load More and retryable failure states are visible.
- Filter changes and live refresh reset both loaded flows and the cursor.
- An expression/partial index supports logged-tier `flow_id` lookups.

## Test evidence

- Flow pagination tests prove 11 flows cross three pages without duplicate IDs
  and every selected flow retains both request and response.
- A scope-before-limit counterexample returns older in-scope flows despite newer
  out-of-scope traffic.
- Focused database, renderer, i18n and design suites: 44 tests passed.
- TypeScript and production build passed.
- Full Vitest suite: 2,057 passed and 2 skipped across 176 files.
- Electron HTTP Activity journey: 5 tests passed, including activity grouping,
  request reachability and raw-flow view.
- `git diff --check` passed.

## Amendment 2026-10-01 — auto-load to completion (US2 / FR-004 / FR-007)

The recent-subset state was the resting state: a session over the 500-flow page
size stopped at the first page behind a "Load More" button. US2 is reframed so
HTTP History auto-follows the cursor to completion, and the subset state becomes
a backstop reached only at the `AUTO_LOAD_MAX_FLOWS` (5,000) cap. The paging
backend (`queryHttpFlowPage`, 500-flow page) is unchanged; the panel now chains
`loadFlows(true)` on each `hasMore` until the record is whole or the cap is hit,
and stops the chain on a page failure so the existing retry surfaces (FR-007).

- The completeness strip shows the loading state while auto-following, and the
  amber subset marker plus manual continue only at rest past the cap.
- `test/http-auto-load.test.tsx` proves the panel follows multiple pages to
  completion unattended and halts at the cap with the subset state and button.
- Contract (`http-flow-query-contract`, `shared-event-filter`) still holds: the
  500-flow page query, `httpHistory.loadMore`, completeness and failure states
  all remain.

## Amendment 2026-10-01 — flat per-request log, Activity view removed (US1 / FR-006)

HTTP History is now a single flat table (Burp HTTP-history shape); the Activity
grouping (point/span rows, ⌘ command attribution, the Activity/Every-Request
toggle) is removed. Correlating traffic with the command that produced it is the
Timeline's job — the main Timeline and its fold (`timelineFold`) are untouched,
and the ↗ timeline jump stays on each request row and in the detail pane. The
timestamp moves to the leading column (UIUX-STANDARD §6). Deleted with the
feature: `ActivityRow`, `parentCommandOf`, `flow.causeEventId`, the out-of-scope
host marker, the `src/renderer/src/lib/httpActivity.ts` grouping module and its
`test/http-activity.test.ts`; `e2e/http-activity-view.spec.ts` is rewritten as
`e2e/http-history-view.spec.ts` asserting the flat log. The architecture gate
confirms no export was orphaned by the deletion.

## Convergence

The spec, plan and tasks match the implementation. No required task remains.
Local URL, method, status and host controls intentionally filter loaded flows;
moving those predicates into the flow query is a separate search-faceting change.
