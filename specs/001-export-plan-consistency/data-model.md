# Data Model: Export Plan Consistency

## ExportRequest

Operator intent: `format` (`json | ndjson | bundle | har | timeline`), explicit `subset` (all or time/target bounds), `sharing`, `maskOutOfScope`, `scopeOnly`, and `scrubPii`. Unsupported combinations fail resolution.

## ExportPlan

Immutable main-process approval object:

| Field | Rule |
|---|---|
| `id` | Random opaque identifier |
| `projectId` | Must match active project at execution |
| `createdAt`, `expiresAt` | Expired plans cannot execute |
| `request` | Normalized and frozen |
| `snapshot` | Row bounds for both event tiers |
| `scopeSnapshot` | Targets, excludes, personal domains and source hash |
| `capabilities` | Truthful format behavior |
| `counts` | Derived from exact planned selection |
| `fingerprint` | SHA-256 of canonical request, boundaries, IDs and policy outcomes |
| `status` | `ready | executed | expired | invalidated` |

## ExportCounts

`examined`, `included`, `excludedDoNotExport`, `excludedPersonal`,
`excludedBlacklist`, `maskedOutOfScope`, `sanitized`,
`attachmentsIncluded`, `attachmentsMissing`, `attachmentsUnattributed`,
and `unsupported`. Event and attachment totals remain separate.

## ExportResult

Contains `ok`, matching plan ID/fingerprint, optional artifact path, actual
counts, warnings, and a typed error. Partial or failed output never returns
`ok: true`.

## State Transitions

```text
request -> ready -> executed
             +--> expired
             +--> invalidated
```

Execution of a non-ready plan returns an explicit error and reports no
successful artifact.
