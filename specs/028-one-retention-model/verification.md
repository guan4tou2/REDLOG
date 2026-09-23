# Verification: One Retention Model

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/one-retention-model.test.ts` failed on all three tests: the default
config had no `retention.casts`/`screenshots`/`httpBodies`/`agentTranscripts`,
still had top-level `screenshots` and `httpBodies` and `terminal.castKeepDays`,
and five source files read the old spellings. With their config literals moved
to the new shape, 18 sweep tests in `retention`, `artifact-eviction` and
`body-eviction-sweep` failed because the sweeps still read the old keys. The new
"old config deletes nothing" test failed because the old sweep honoured
`terminal.castKeepDays`.

## GREEN

- Every store's retention is under `retention.<store>` with `keepDays` /
  `maxBytes`, all defaulting to `0`; `terminal` keeps only `maxCastBytes`.
- The three sweeps take `Pick<RedLogConfig, 'retention'>`.
- Settings writes the three size budgets to `retention.<store>.maxBytes`.
- `docs/TESTING.md` §2.6 lists the real keys; the non-existent `io.*` options
  are gone. Live design docs use the new names.

## Evidence

- Retention, eviction, config and the new suite: 42 pass.
- Full suite: 194 files pass in the sandbox. `api-server`, `external-session`,
  `shell-redlog-run` and `file-watcher` need sockets the sandbox refuses and
  pass outside it — 27/27.
- Typecheck and production build pass.
