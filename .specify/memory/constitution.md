# RedLog Constitution

## Core Principles

### I. Evidence Integrity

Recorded Events and Evidence MUST NOT be silently mutated, discarded, or
re-attributed in a way that changes their evidentiary meaning. Masking,
sanitization, filtering, and presentation MUST operate on explicit projections
or export copies. Any deliberate omission, truncation, gap, amendment, or
retention action MUST remain visible and attributable.

### II. Surface Truthfulness

A user-facing surface MUST NOT present filters, counts, previews, health,
empty states, or result sets as authoritative when the underlying operation is
partial, stale, failed, capped, or governed by different semantics. Labels and
status states MUST describe what the system actually knows.

### III. Canonical Domain Semantics

Target identity, Scope evaluation, Event ordering, Export Selection, and every
other shared domain rule MUST each have one canonical implementation. Renderer,
preload, IPC, capture producers, persistence, and exporters MUST consume that
implementation or a shared contract derived from it; they MUST NOT recreate
the rule independently.

### IV. Query Completeness

Every bounded query MUST expose its completeness through `hasMore`, a total,
an explicit subset label, or an equivalent observable signal. Limits MUST be
applied after all supported selection predicates at the persistence layer.
Client-side filtering of a capped result MUST NOT be presented as a complete
project query.

### V. Preview / Execute Consistency

An evidence export preview and its execution MUST use the same resolved event
selection, Scope snapshot, sharing policy, attachment policy, and dataset
boundary. If data changes after preview, RedLog MUST execute against the
previewed snapshot or explicitly disclose and quantify the difference. The
resulting manifest MUST describe the artifact actually produced.

### VI. Explicit Failure

No-result, not-yet-indexed, partial-result, query-failed, capture-failed, and
unknown states are distinct and MUST remain distinct across every layer.
Fallback behavior MUST NOT convert an error into an empty or successful result.
Errors MUST retain enough source and recovery context for the operator to act.

### VII. Evidence Provenance

Derived Events, projections, grouped Activities, AI tool pairs, and
sanitization records MUST preserve references to their source Events or
Evidence whenever the source supports such a relationship. Source occurrence
time and RedLog receipt time MUST remain distinguishable. AI-reported behavior
MUST NOT be represented as independently observed execution.

### VIII. Risk-Based Test-First Verification

Changes to evidence semantics, domain invariants, selection, pagination,
Scope, Target identity, project attribution, or export behavior MUST begin with
an observable test that fails for the intended reason before implementation is
changed. The change MUST then pass targeted tests, typecheck, the relevant
integration tests, build, and any affected desktop E2E journey before being
marked Verified. Low-risk copy and styling changes MAY omit test-first work but
MUST still receive proportionate verification.

### IX. Architectural Restraint

RedLog MUST preserve its Electron, React, SQLite, and local-first architecture
unless measured evidence demonstrates that a larger change is necessary.
New frameworks, adapters, abstraction layers, and module seams MUST solve a
present variation or policy-duplication problem. Structural purity alone is
not sufficient justification.

## Product Boundary

RedLog records, preserves, finds, explains, and exports authorized red-team and
penetration-test activity. New work MUST strengthen capture coverage,
provenance, integrity, investigation, or handoff. Case management, SIEM rule
engines, automated attack orchestration, scoring platforms, and cleanup task
management require a separate product decision and MUST NOT enter through an
unrelated feature plan.

`docs/domain/glossary.md` and `docs/domain/SPEC-*.md` are living domain
contracts. Feature specifications under `specs/` MUST reference them rather
than duplicate their rules. A feature that changes a domain invariant MUST
update the canonical domain contract as an explicit task.

## Development Workflow and Quality Gates

Every bounded feature MUST follow Specify → Plan → Tasks → Implement →
Converge. Features involving evidence, privacy, cross-layer contracts, or more
than one of renderer/preload/IPC/core/persistence MUST also run Clarify,
Checklist, and Analyze before implementation.

Each feature artifact set MUST:

- define observable scenarios and failure states without prescribing the
  implementation in `spec.md`;
- identify the canonical module interface and affected domain invariants in
  `plan.md`;
- order tasks from failing behavior tests through implementation, integration,
  verification, and domain-document status updates;
- distinguish Implemented from Verified;
- record, in `verification.md` built from
  `.specify/templates/overrides/verification-template.md`, the RED failure
  reason, the final verification evidence, and the outcome of every workflow
  gate — including a gate that ran clean or was not required, with the reason.
  Analyze, a question-free Clarify and a clean Converge write nothing
  themselves, so this record is the only evidence that they ran.

CI (`npm run verify:specs`) rejects an unknown status value and a Verified
feature whose artifacts or verification record do not meet this section.

Small, diagnosed defects MAY use the shorter assess → fix → verify workflow.
They MUST still comply with every applicable principle. A passing local subset
does not override a failing typecheck, build, relevant integration suite, or
required E2E journey.

## Governance

This constitution overrides conflicting feature plans, task lists, and local
implementation convenience. Domain contracts remain authoritative for their
defined terms and invariants; when a conflict is found, work MUST stop at the
artifact layer and the conflict MUST be resolved before implementation
continues.

Amendments require a documented rationale, affected principles, migration
impact, and semantic version change. Removing or weakening a principle is a
MAJOR change; adding a principle or materially expanding governance is MINOR;
clarification without semantic change is PATCH. Every feature review MUST
include a Constitution Check, and Converge MUST not report completion while an
applicable gate is unmet.

The Sync Impact Report at the top is review scaffolding and MUST be removed
before the constitution change is committed.

**Version**: 1.1.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-23
