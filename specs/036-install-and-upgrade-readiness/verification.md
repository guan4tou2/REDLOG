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


## 2026-10-14 candidate installation follow-up

main@9f8bf28 plus local recording/setup fixes; not merged or released.
macOS ARM candidate DMG SHA-256: `7e723ef8c19739b2045ca721261f03e17f52f4b4597f06f1599ab00d0e8dcb01`.

Read-only DMG mount, copy into an isolated install directory and launch pass.
Packaged smoke (2 tests) verifies ordinary external Zsh stdout and failing exit,
PTY helper, built-in provenance/cast, real HTTP/HTTPS using per-command CA trust,
ExportPlan projection with the canary/cast delivered, verifier, restart/search
and the recovered capture-setup entry. Hook install is idempotent and removal
restores rc. Source first-run UI journey: 10 PASS (seeded rows prove UI only).

This is a local macOS milestone, not clean-host or all-platform completion.
Windows/WSL and Kali desktop installation, macOS download quarantine/Gatekeeper, Dock launch and clean
missing-dependency remediation remain unrun. A separate fresh Kali Rolling 2026.3
container verifies actual Zsh stdout/stderr/exit 3 and Bash 5 fast payloads; it is
not a desktop installer result. Spec 047's full wizard is still
Draft; its recovery entry is recorded separately in its partial verification.

Final candidate includes persistent HTTP installer errors/manual remedy, an
actual post-install PATH check, and unique offline spool filenames retaining
the time prefix. Full unit suite: 3540 PASS / 23 SKIP; final shell-only prefix
check: 160 PASS. Source FirstRun 10-test journey PASS. Final packaged core flow PASS; explicit
session failed once with missing short-command stdout, then 25 same-candidate
repeats PASS. Root cause remains unknown (#333); the entire package matrix is
not declared complete.
Typecheck, Spec Kit, architecture, i18n and packaged-resource gates PASS.
