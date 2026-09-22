# Implementation Plan: Command Artifact Linking

## Constitution Check

- Evidence Integrity: uncertain attribution remains absent.
- Canonical Domain Semantics: causal resolution stays in `causes-resolver`.
- Evidence Provenance: the file event cites the observed command start.
- Risk-Based Test-First Verification: resolver behavior is specified by failing tests first.
- Architectural Restraint: extend the current ingest and file-watcher path.

## Design

1. Track active shell command starts with event ID, normalized cwd and time.
2. Transition ended commands to a bounded grace state for delayed watcher delivery.
3. Attach explicit candidate metadata to file-watcher events without changing `_causes`.
4. Preserve every matching candidate and its correlation method.
5. Settle lifecycle state even when recording is paused.
6. Add cwd to supported shell command-start producers.
