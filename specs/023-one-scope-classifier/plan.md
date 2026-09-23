# Implementation Plan: One Scope Classifier

## Technical Context

- `scope-evaluator.ts` holds `normalizeSubject`, `matchPattern` and
  `evaluateScope` (filter status). `matchPattern` is already shared.
- `alert/policies.ts` holds `classifyScopeTarget` (distance, authority,
  severity), `buildScopeIndexes`, and the private helpers `isIPv4`,
  `registrableDomain`, `domainFor`, `subnetOf`. Its adjacency rungs read the
  raw subject.
- `ScopeDistance`, `Authority`, `Severity` live in `alert/policy.ts`.
- `ScopeSnapshot` is declared in both `alert/policies.ts` and
  `scope-recompute.ts`.
- `scope-sanitize.ts` (export masking) imports `classifyScopeTarget` from
  `./alert/policies`; `scope-recompute-run.ts` imports it with
  `buildScopeIndexes` and `isReportable`.

## Constitution Check

- **Canonical Domain Semantics**: the feature exists to satisfy it — one
  decision procedure, two views.
- **Surface Truthfulness**: the filter and the export can no longer describe
  one target two ways.
- **Evidence Integrity**: recompute keeps producing the live path's verdict;
  rows it newly flags were misclassified before, and recompute already records
  its runs as events.
- **Risk-Based Test-First Verification**: the normalisation, exclude-only and
  view-agreement cases begin as failing tests.
- **Architectural Restraint**: no new module. The classifier moves to the
  module the constitution already names; the dependency direction becomes
  alert → scope, which is the direction the domain implies.

## Design

1. Move the adjacency helpers, `ScopeIndexes`, `buildScopeIndexes` and the
   `ScopeDistance` type into `scope-evaluator.ts`.
2. Add `classifyScope(subject, policy, indexes?)` returning
   `{ status, distance, matchedBy? }`. It normalises the subject once, and
   builds indexes from normalised scope entries.
3. Re-implement `evaluateScope` as the status view of `classifyScope`.
4. Keep `classifyScopeTarget` in `alert/policies.ts` as the alert mapping:
   `classifyScope(...).distance` plus authority and severity. It no longer
   classifies anything itself.
5. Point `scope-sanitize.ts` at `scope-evaluator.ts`.
6. Delete the duplicate `ScopeSnapshot`; `scope-recompute.ts` imports the alert
   one, since a snapshot carries the alert floor.
7. Add a guard test and update the domain contract.

## Gate

The normalisation, exclude-only, view-agreement and guard tests, the existing
scope, alert and recompute suites, typecheck, the full suite and build must
pass before Verified.
