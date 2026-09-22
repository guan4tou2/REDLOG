# Research: Export Plan Consistency

## Decisions

1. **Extend the existing row-bound snapshot.** Use `ExportSnapshot` as the dataset boundary inside a richer `ExportPlan`. It already prevents concurrent inserts without copying sensitive payloads. Long SQLite transactions and temporary evidence copies were rejected because confirmation is a human-duration interaction.

2. **Resolve one immutable format-specific plan.** Preview receives format, subset and policies; main returns a plan identifier, normalized request, snapshot, capability declarations, counts and fingerprint. Execution accepts only the plan ID. Sending mutable toggles back at execution would preserve the current divergence risk.

3. **Keep plans in a bounded in-memory registry.** Scope plans to the active project, age and maximum count. Project switches and restarts invalidate them visibly. Persisting short-lived approval objects would add cleanup and privacy risk.

4. **Declare capabilities per format.** Every format reports support for snapshot bounds, scope masking, exclusions, PII scrubbing, attachments and bounded subsets. Unsupported requested protection blocks resolution.

5. **Migrate adapters in tested steps.** JSON, NDJSON and Evidence Bundle already accept snapshots and migrate first. HAR and Timeline receive snapshot-aware bounded adapters next. No format is labelled compliant before migration.

6. **Return the actual result.** Execution returns artifact path, plan ID/fingerprint, actual counts, warnings and errors. Bundle records this in its manifest; single-file formats may use an adjacent compact manifest.
