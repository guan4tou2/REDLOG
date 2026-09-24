# Verification: Loot Rule Time Bound

## RED

`test/loot-regex-time-bound.test.ts` against unchanged code: the run **hung**
on the first test — the `(a+)+$` plugin rule ran in-process on the hostile
input — and was killed by a 45 s timer (`timeout 45 npx vitest run …`, exit
124) with no test result. That hang is the defect: the same call on the ingest
path freezes capture and the UI.

## GREEN

- `loot-regex-time-bound`: 3 pass — the overrunning rule is stopped and the scan
  returns the AWS key and the other plugin rule; the stop is reported and the
  rule is not run again; re-registering clears it.
- `loot-rules-group`: 4 pass, including the stopped-rule mark.
- Existing loot suites (`loot-correctness`, `loot-rule-switches`,
  `loot-detector`, golden) pass with plugin rules now in the worker.
- Inside Electron's main process (esbuild bundle of `bounded-regex.ts` run by
  `npx electron`): an ordinary rule returned in 48 ms; `(a+)+$` was cut at
  255 ms with `stuckAt: 0`.
- Full suite outside the sandbox: 213 files, 2308 tests pass. Typecheck and
  production build pass; the worker source is in `out/main/index.js`.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 5 answered (bounded rules, budget, overrun handling, visibility, masking consequence) — recorded in spec.md | 2026-09-23 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-23 |
| Analyze | no findings: FR-001–006 each map to a task and a test; FR-006 covered by the unchanged golden and loot suites | 2026-09-23 |
| Converge | no findings; the plugin guide sentence Spec 031 wrote ("still runs in the main process") was corrected in this change | 2026-09-23 |
