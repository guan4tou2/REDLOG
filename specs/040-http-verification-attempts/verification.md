# Verification: HTTP verification attempts

## RED

- `npx vitest run test/http-verification.test.ts`: 3 failed because new attempt helpers did not exist. Invalid-input assertions were not counted as meaningful RED until the helper existed.
- `npx vitest run test/first-run-record-terminal.test.tsx`: 7 failed / 16 passed, missing attempt controls and old broad first-event behavior.
- Real local proxy smoke: Chromium HTTP passed, curl HTTPS returned the correct origin body but the database contained only `http_request_start`.
- `npx vitest run test/mitmproxy-tls-serialization.test.ts`: failed with `TypeError: Object of type IPv4Address is not JSON serializable`; conversion to text fixed the original real HTTPS flow.

## GREEN

- `npx vitest run test/http-verification.test.ts test/first-run-record-terminal.test.tsx test/managed-http-proxy.test.ts test/mitmproxy-tls-serialization.test.ts test/mitmproxy-addon-hooks.test.ts test/ca-trust-commands.test.ts`: 6 files / 59 tests passed.
- `npm run typecheck`, `npm run build`, `npm run verify:architecture`, `npm run verify:specs`, `git diff --check`: passed. Build has existing config browser-externalization warnings.
- `npx playwright test e2e/app-shell-layout.spec.ts e2e/first-run.spec.ts e2e/setup-command-review.spec.ts --workers=1`: 9 passed on final source build.
- `REDLOG_REAL_PROXY_TEST=1 npx playwright test e2e/http-verification.spec.ts --workers=1`: real Chromium HTTP and curl HTTPS passed after the SAN fix.
- `npx electron-builder --dir --mac --arm64 --publish never -c.mac.identity=null`: created a fresh unsigned local App; no release published.
- `REDLOG_REAL_PROXY_TEST=1 REDLOG_PACKAGED_APP="$PWD/dist/mac-arm64/RedLog.app/Contents/MacOS/RedLog" npx playwright test e2e/http-verification.spec.ts e2e/packaged-session-smoke.spec.ts e2e/app-shell-layout.spec.ts --workers=1`: **3 passed** on final package, including 800/1000/1400px and English/Traditional Chinese.
- `npm run verify:package-resources`: passed; addon is now an explicitly required resource. `cmp` confirms packaged addon equals the repaired source.

The earlier complete suite (2773 passed) predates this bounded feature. It is not represented as a new full-suite run here.

## Operational Verification

Risk surface: capture / external integration / packaged capture resource.

HTTP section of RELEASE-SMOKE-TEST.md exercised with real mitmproxy 12.2.3,
Electron 44.4.1 and local HTTP/HTTPS origins in isolated HOME. Browser HTTP and
external curl HTTPS captured the actual 404 body; only the correct two slots
passed, unrelated traffic did not. Proxy stop cleared the results. Copy was
checked against the real clipboard. Keyboard navigation and compact layouts
were operated and screenshots reviewed. The TLS origin certificate included IP
SANs, reproducing the missing-response bug before its repair.

EXTERNAL SHELL package subset: installed the packaged Zsh/session helper into
the temporary HOME, ran its canary, found output through the application's search.
This is not a complete installer matrix. Download/checksum, DMG install,
Gatekeeper, Windows/PowerShell/WSL and Linux package flows remain under #226.
The generated PowerShell recipe is unit-tested, not claimed as a real PowerShell run.

No OS CA trust or real user shell profile was changed. Origin CA trust was local
to the test proxy config; client trust was supplied only to the curl subprocess.

## Release Impact

| | |
|---|---|
| User-visible | yes |
| Breaking | no |
| Packaging affected | addon resource content fixed; layout unchanged |
| CHANGELOG updated | yes |
| Upgrade note required | no schema or profile change |
| Packaged smoke required | yes; local macOS ARM App passed; platform release matrix remains #226 |

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | No questions; cooperative client attribution, late responses and trust limits explicit | 2026-09-27 |
| Checklist | 12/12 requirements-quality criteria satisfied; agent review, not runtime proof | 2026-09-27 |
| Analyze | 9/9 FR covered; no constitution conflict or orphan tasks; discovered SAN defect added as diagnosed T008 | 2026-09-28 |
| Converge | 9 FR, 4 success criteria, 8 acceptance scenarios and design decisions checked; no remaining implementation gaps in this bounded feature | 2026-09-28 |

No extension hooks configured. Converge left tasks unchanged; completion marks
and this evidence record were written by the implementation workflow afterwards.

## Integration with main #235

Final integration verification (2026-09-28):

- Full Vitest after merging the two implementations: 287 files passed, 1 skipped;
  2897 tests passed, 11 skipped (original performance/platform exclusions).
- Follow-up lifecycle regression reproduced stale core-ready after a proxy
  restart. Applied status/nonce reset atomically and propagated false to the
  first-run summary; targeted 3 files / 50 tests passed.
- Final source-specific regression: 10 files / 119 tests passed, including
  same-length artifact replacement and canonical attachment references.
- Development Electron journeys: 18/18 passed (onboarding, export preview,
  target return, transcript, setup draft, real HTTP/HTTPS and narrow chrome).
- Screenshot review found the source disclosure overlapping HTTP on the narrow
  stacked onboarding. Fixed the flex sizing and added non-overlap geometry
  assertions at 800/1000/1400px in both locales. Removed directional "on the left"
  copy and separated client/protocol labels from their response status.
- Fresh unsigned macOS ARM App: 3/3 passed (real HTTP/HTTPS, packaged session
  helper, final narrow layout). Final screenshot reviewed; no overlap.
- typecheck, build, architecture gate, Spec Kit gate and packaged-resource
  verification passed. No installer/release uploaded; Windows/WSL and
  Gatekeeper remain outside this local smoke.

These replace the earlier source-state assumptions for the merged branch;
the original RED/GREEN history above remains a record of the earlier change.
