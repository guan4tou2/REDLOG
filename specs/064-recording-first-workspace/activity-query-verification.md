# Activity query implementation checkpoint

Status: Partial implementation of Spec 064; the existing reading/navigation UI is unchanged.

Scope: stable act1 identities, database grouping before paging, matching/context counts, bounded source pages, snapshot-bound cursors, exact Claude Code/Codex tool classification, and active-project/scope checks in IPC. Source Events and their hashes are unchanged. Missing producer identity remains Event-addressable; conflicting data stays visible.

The derived SQLite TEMP index belongs to the read connection. It holds metadata and payload digests, updates for appended rows, rebuilds after retention or failed reads, and disappears when the project closes. It is not evidence or an export attachment.

## Validation

This narrowly selected commit is validated independently from other uncommitted capture/UI changes. Clean selected-tree validation on macOS arm64, 2026-10-26:

- typecheck → verify:specs → verify:architecture → verify:i18n → npm test: all gates passed; 4264 tests passed, 29 skipped. Log: `/private/tmp/redlog-activity-push-unit.log`.
- Production build passed. Existing Transcript Electron journeys, including actual ingest → Activity preload/IPC → bounded matching/context reads and foreign-project rejection: 2 passed, 0 skipped/flaky. Report: `/private/tmp/redlog-activity-push-e2e.json`.
- After Electron validation, restored the shared SQLite addon to the Node test ABI.

Earlier whole-worktree results are not represented as this commit's acceptance. This validation does not cover native Windows/Linux acceptance, a packaged installer, or the planned Activity reading UI.

## Remaining work

Search coverage/index reporting, Activity reading UI, common content readers/anchors, new Activity/Session export selection, navigation/settings consolidation, and native cross-platform acceptance remain open. The full Spec 064 is not complete; no installer or release is produced by this checkpoint.
