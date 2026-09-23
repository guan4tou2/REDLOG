# Implementation Plan: Remove the Plugin Code Host

## Constitution Check

- **Surface Truthfulness**: user-facing documents stop claiming an isolation
  the product does not provide.
- **Explicit Failure**: a manifest with a retired code key is refused, not
  loaded and ignored.
- **Architectural Restraint**: removes a layer with no present consumer, whose
  own comment deferred it to a future that was never planned.
- **Risk-Based Test-First Verification**: refusal, removal and the preserved
  tailer gate begin as tests; trust-gate fixtures move from `exporters` to
  `tailers` so they keep testing the gate rather than the refusal.

## Design

1. Remove `plugins/host.ts`, the host wiring in `plugins/index.ts`, and the
   services block and imports in `main/index.ts`.
2. Delete `resources/plugin-runner.js` and its `electron-builder.yml` entry.
3. Drop `exporters`/`monitors` from the contribution type and from
   `PRIVILEGED_KEYS`; refuse them by name in `validateManifest`.
4. Correct the plugin tier comment in `plugins/types.ts`.
5. Correct `README.md`, `docs/plugin-development.md`, `docs/ARCHITECTURE.md`
   and `docs/ROADMAP.md`. Dated audit documents are left as historical records.
6. Remove `searchEvents`; port its tests.
