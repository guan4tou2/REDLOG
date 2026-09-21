# Implementation Plan: Pre-release Contract Reset

## Technical Context

- Electron + React + TypeScript application with SQLite persistence.
- Public surfaces include local HTTP API, CLI, preload IPC and plugin methods.
- Canonical evidence contracts live in core modules and current domain specs.
- No released installation or persisted-data contract must be migrated.

## Constitution Check

- Evidence Integrity: current events keep one deterministic hash/signature shape.
- Surface Truthfulness: removed aliases fail explicitly rather than silently translating.
- Canonical Domain Semantics: callers move to canonical target, scope, export and event interfaces.
- Preview / Execute Consistency: legacy export execution paths are removed.
- Explicit Failure: resilience failure states remain distinct from version translation.
- Risk-Based Verification: contract-removal tests precede each implementation group.
- Architectural Restraint: delete seams and branches; add no framework.

## Canonical Interfaces

- Current bookmark API and CLI vocabulary only.
- Batched renderer event delivery only.
- Provenance-aware target extraction and canonical scope matching only.
- ExportPlan preview and execution only.
- Current event/output/hash/signature/configuration shapes only.
- Test helpers live under `test/`, outside production exports.

## Phases

1. Inventory compatibility code and classify runtime resilience separately.
2. Remove public aliases and migrate active callers.
3. Remove persistence, renderer-state and evidence-shape migrations.
4. Remove production test shims and stale specifications.
5. Run targeted, full, type, build and Electron verification; converge artifacts.

## Gate

Historical prose remains in changelogs/audits. Executable source, current docs
and tests must contain no supported old-version contract.
