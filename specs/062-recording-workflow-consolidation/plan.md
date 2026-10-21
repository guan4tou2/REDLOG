# Implementation Plan: Recording workflow consolidation

**Date**: 2026-10-21 | **Spec**: [spec.md](spec.md) | **Checkout**: main

## Delivery slices

This plan implements US6 / FR-012–014 and related FR-016 first. US1–4 and US7 have an existing-code audit and bounded Mac acceptance in audit.md and mac-acceptance-20261021.md; that evidence is not a complete cross-platform verdict. US5 optional AI installation remains a separate subsequent slice. The overall specification stays Draft.

## Summary and technical context

Replace ExportMenu's format menu followed by a preview with one existing-style dialog: range, format, policies, destination, resolved preview, attachments and one confirmation. React 19 / TypeScript / Electron 44, existing local ExportPlan IPC and SQLite persistence. No dependencies, schema, capture producer or backend policy changes. Vitest + Testing Library verify requests and races; affected Electron journeys verify exported bytes. macOS native UI acceptance supplements them. Desktop small windows and zoom are in scope; no mobile app is introduced.

## Canonical interface and invariants

Use src/core/export-plan.ts and export-capabilities.ts unchanged, via resolveExportPlan / executeExportPlan. Copy the view contribution and shared filter when opening. Range is current-selection or all; format does not alter it. Changing range, format, policy or attachments invalidates the old plan immediately and resolves a new one; out-of-order replies cannot enable confirmation. Execute sends only the approved plan id and destination. Closing invalidates pending replies. A failed single-use plan requires re-resolution.

Format choices preserve JSON, NDJSON, bundle, and a contributing view's HAR/timeline. Default to that view's specialized format if present; otherwise retain the existing remembered general format. PII and masking controls are disabled with explanations when unsupported; disable PII-incompatible format options while PII is selected, without silently clearing the policy. HAR must not claim scope masking. Destination is independent from selection. Attachment exclusions survive format switches within the dialog.

## Constitution check (before and after design)

Evidence integrity and canonical semantics: no source mutation or duplicated selection rules. Surface truthfulness: actual plan counts, scope and errors; unsupported policies do not claim success. Query completeness: store resolves the whole bounded query, never renderer rows. Preview/execute: one resolved plan, latest request only. Verification: failing behavior tests precede implementation, then regression, typecheck, i18n, architecture, specs, build and affected Electron journeys. Restraint: no new export service or framework. No violations identified.

## Source and documentation

- src/renderer/src/components/ExportMenu.tsx: dialog and local request transitions.
- src/renderer/src/i18n/{en,zh-TW}.json: range/format purpose labels.
- test/export-*.test.tsx: behavior and retained policy/attachment regressions.
- e2e/{export-preview,filtered-export}.spec.ts: keyboard, narrow viewport and artifact verification.
- specs/062-recording-workflow-consolidation/{research,data-model,quickstart,tasks,verification}.md and contracts/export-dialog.md.

No new architecture or domain invariant is required. Existing docs/domain/SPEC-export-event-selection.md remains authoritative.

## US5 first increment — local installation only (2026-10-22)

The next bounded increment is the official AI capture-plugin installation backend, through the existing plugin IPC/preload surface. The three offline manifest templates live in code, outside auto-discovery, and are written to the user plugin directory only on an explicit request. No download, package manager, AI-tool installation, transcript read, or project-config mutation occurs. Core manager owns an allowlist and validates managed bytes before replacing/removing anything. Modified directories, symlinks and unknown ids fail explicitly. Catalog read errors remain errors. Installation state is not recording state.

This increment does not satisfy all US5: per-tool project activation, project-scoped watch paths, start boundary, health/UI and removal of the old AI preset still require T015–T019. The installed templates declare no executable code or capture contribution until that integration is implemented. Do not advertise the backend as a working AI capture plugin UI. No new framework or persisted evidence schema.
