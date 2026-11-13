# Verification record — Spec 072

Status: Draft. This file records Phase 1 (pin today's behaviour) only. No task is ticked.

## Phase 1 — T002 writer inventory against report 10 A.1

Measured by `test/kinds/inventory.ts` (TypeScript AST scan plus per-language scans of hooks, tools, plugins and optional-plugins).

| Item | Report 10 A.1 | Measured on main |
|---|---|---|
| Distinct kind ids | not stated as one number | 137 (`KIND_COUNT` in `inventory.test.ts`) |
| `agent_type` values | 17, including `clipboard` | 16 |
| `system` subtypes | about 45 | 40 |
| `clipboard` | listed | no writer: `clipboard-monitor.ts` no longer exists, so no example row either |
| `system:export_sealed`, `*_pruned`, `http_body_pruned` | not listed | written today, so in the inventory |

## Premises of the plan that are stale on main

- `redirected` and `unknown` output states and the `content.output.*` notes already exist (#591, 1febccf9).
- `eventReader` already returns `image` for a screenshot.
- Titles already exist for pcap, c2 and the agent refusal kinds.
- `hasSpecificEventDetail` was renamed `eventReader`; `knownLists.isHousekeeping` is private.
- `test/extensions` and `import-graph.ts` (Spec 076) are not on main.

## Findings not in the spec

- Late or streamed `shell:command_output` rows are hidden by HOUSEKEEPING_SQL but counted as work by EVIDENCE_SQL and `isEvidence`. Pinned with `it.fails` in `housekeeping-consistency.test.ts`; the spec does not say which side is right.
- `src/core/db/event-write.ts` lines 96-99 still say a `tier-classifier-total` test exists. T010 asked to fix the comment, but it is in `src/`, which Phase 1 may not touch.
