# Quickstart: Verify Export Plan Consistency

## Automated checks

1. Run export plan unit and IPC contract tests.
2. Run renderer tests for preview loading, failure, expiry and confirmation.
3. Run existing JSON, NDJSON, HAR and bundle regression tests.
4. Run typecheck and production build.
5. Run the export preview Electron journey in an isolated test project.

## Observable journeys

- **Stable approval**: preview JSON, add chained and logged events, confirm, and verify result count/fingerprint match.
- **Bounded view**: filter HTTP by target/time, preview HAR, and verify the artifact contains exactly those flows.
- **Policy disclosure**: enable sharing/scope masking and verify exclusions, masking, PII and attachment behavior are named. Unsupported protection blocks confirmation.
- **Failure truthfulness**: expire or invalidate a plan; verify no success toast or completed artifact and require a refreshed preview.

Record the RED failure, final targeted results, typecheck, build, regression
suite and desktop journey in `tasks.md`. Do not mark Verified without the
desktop journey.
