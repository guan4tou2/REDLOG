# Verification: Install and Upgrade Readiness

## RED

- W1 `test/runtime-preflight.test.ts` (14): first `Cannot find module`; then,
  against a stub, "zsh/bash unavailable when python3/curl missing" failed with
  `expected true to be false` — **the hook was reported available without
  python3**; requiresAll undefined; PowerShell install `expected false to be
  true` (installMethod was manual).
- W5 `test/runtime-readiness.test.tsx` (7): module missing.
- W2b `test/login-path.test.ts` (16): module missing.
- W2 (docs/workflow): 15 stale claims, each checked against code before editing;
  the checksum step was run against a fake artifact tree and failed as intended
  on an empty tree.

## GREEN

- Worker suites: preflight 14, readiness 7, login-path 16 pass.
- Spec-gate exemption: a probe file containing a retired name elsewhere under
  `src/` still fails `verify:specs`.
- Integrated branch, outside the sandbox: 218 files, 2304 tests pass;
  typecheck, production build, `verify:architecture` (7 allowlisted) and
  `verify:specs` pass.
- Checksum step: `shasum -a 256 -c SHA256SUMS.txt` → OK on the fake tree.
- Not verified: a real Windows host (PowerShell), a packaged Dock launch.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 4 answered (notarization out, no self-xattr, no shim, gate exemption) — in spec.md | 2026-09-24 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-24 |
| Analyze | 1 finding fixed: preflight could run before the login PATH landed and report installed tools missing — `runtime:preflight` now awaits `loginPathReady` | 2026-09-24 |
| Converge | 1 finding carried to Spec 037: docs say scope is entered one entry at a time, which W3 changes to paste | 2026-09-24 |
