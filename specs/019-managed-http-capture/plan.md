# Implementation Plan: Managed HTTP Capture

## Technical Context

Electron main owns subprocesses. A small service wraps `mitmdump`, resolves
readiness from its output/liveness, and exposes a state snapshot. Existing
browser and terminal launchers consume that service; the existing Python addon
continues to perform all event ingestion.

## Constitution Check

- **Surface Truthfulness / Explicit Failure**: launch success requires a live
  proxy; errors are retained and shown.
- **Evidence Integrity / Provenance**: reuse the shipped addon and current
  ingest contract.
- **Canonical Domain Semantics**: one service owns proxy state and URL.
- **Risk-Based Verification**: lifecycle, browser gating, and environment
  injection are test-first.
- **Architectural Restraint**: manage the existing dependency; do not build a
  proxy engine or privileged transparent interception.

## Design

1. Add a managed-proxy service with injected process/path dependencies for
   deterministic lifecycle tests.
2. Add IPC and preload contracts for status/start/stop.
3. Start only on an explicit capture/browser action; stop on project close.
4. Gate the proxied-browser launch on managed readiness for matching loopback
   proxy URLs.
5. Configure terminal-manager with the live URL and inject it only at spawn with explicit project routing consent.
6. Add a compact HTTP capture control beside the browser action and truthful
   bilingual states.

## Gate

Focused lifecycle/UI/terminal tests, typecheck, full Vitest, production build,
Spec Kit gate, and a desktop journey must pass.

