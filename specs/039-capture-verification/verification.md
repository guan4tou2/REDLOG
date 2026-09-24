# Verification: Capture Verification Contract

## RED

- `test/first-run-record-terminal.test.tsx` (5 new): verified state had no
  `record-terminal-scope` / session command; HTTP card had no waiting,
  verified or timeout elements (it showed "正在監聽" as success).
- `test/http-verification.test.ts`: module `lib/httpVerification` missing.

## GREEN

- Targeted (first-run, http-verification, i18n-keys, truncation): 28 pass.
- Full suite outside the sandbox: 223 files, 2341 pass (2 skipped);
  `e2e/first-run.spec.ts` 6/6; typecheck, build, `verify:architecture`,
  `verify:specs` pass.
- Not verified: a real proxied-browser request end to end (dogfood).

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 3 answered (no default session, HTTP event definition, PowerShell) — in spec.md | 2026-09-24 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-24 |
| Analyze | 1 finding fixed: English reason quoted a button label that differs from the UI | 2026-09-24 |
| Converge | 0 findings | 2026-09-24 |
