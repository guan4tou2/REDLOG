# Implementation Plan: Active Target Context

## Constitution Check

- Evidence Integrity: target changes append events and never rewrite prior rows.
- Surface Truthfulness: the shell displays the attribution context currently in force.
- Canonical Domain Semantics: ingest owns fallback precedence.
- Evidence Provenance: explicit producer/enrichment evidence wins over operator context.
- Architectural Restraint: extend config, existing IPC and current views.

## Design

1. Persist an optional active target inside the project engagement config.
2. Keep the open project's value in canonical ingest runtime state.
3. Provide dedicated get/set IPC that persists the latest config and appends a change event.
4. Add a compact shell control and direct action on Target rows.
5. Route markers through ingest so marker and screenshot use identical precedence.
