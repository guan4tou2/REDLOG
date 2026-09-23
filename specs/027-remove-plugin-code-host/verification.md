# Verification: Remove the Plugin Code Host

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/plugin-code-host-removed.test.ts`: five tests failed for the intended
reasons — manifests with `exporters` or `monitors` were accepted as
privileged; `plugins/host.ts`, the `createPluginHost`/`setPluginHost` wiring and
`resources/plugin-runner.js` (with its packaging entry) all existed. The sixth,
that `tailers` is privileged, passed and guards the gate that stays.

## GREEN

- The host, its wiring, the services object in main, the capability check and
  the child script are gone; the runner is no longer packaged.
- `exporters` and `monitors` are refused with a message naming the key.
- Three trust-gate fixtures moved from `exporters` to `tailers`, keeping each
  test on its subject — the path-escape test would otherwise have passed on
  the refusal.
- `searchEvents` is removed; `events.test.ts` and `marker-amend.test.ts` run
  their assertions unchanged against the query contract.
- `plugins/types.ts`, `README.md`, `docs/plugin-development.md`,
  `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` no longer claim isolation or
  document the `ctx` API.

## Evidence

- Plugin suites: 24 pass. Ported search tests: 56 pass.
- Full suite: 195 files pass in the sandbox. `api-server`, `external-session`,
  `shell-redlog-run` and `file-watcher` (a known timing flake that failed on one
  of two runs) pass outside the sandbox and in isolation — 29/29.
- Typecheck and production build pass.
