# Tasks: HTTP verification attempts

## US1: Named client and protocol
- [x] T001 [US1] Add failing attempt URL/response/shell recipe tests in test/http-attempt.test.ts.
- [x] T002 [US1] Implement canonical helpers in src/renderer/src/lib/httpAttempt.ts.
- [x] T003 [US1] Add attempt controls and isolated results in src/renderer/src/components/HttpCaptureVerification.tsx and both src/renderer/src/i18n locale files.

## US2: Honest recovery and trust
- [x] T004 [US2] Add failing retry/timeout/lifecycle/failure tests in test/http-attempt-ui.test.tsx.
- [x] T005 [US2] Integrate lifecycle and visible operation failures in src/renderer/src/components/HttpCaptureStep.tsx.

## Verification and contracts
- [x] T006 Add desktop control-flow coverage in e2e/first-run.spec.ts; run affected tests, typecheck, build and architecture/spec gates.
- [x] T007 Update docs/domain/SPEC-capture-source-lifecycle.md, CHANGELOG.md and specs/040-http-verification-attempts/verification.md; Converge against all requirements.

Dependencies: T001 -> T002 -> T003; T004 before T005; all implementation before T006/007.
No parallel agents required. Unit and UI cases independently exercise each story.

## Discovered HTTPS defect
- [x] T008 Reproduce IP SAN response loss in test/mitmproxy-tls-serialization.test.ts and serialize SAN text in hooks/mitmproxy-addon.py; repeat real HTTPS capture.

## Main integration follow-up
- [x] T009 Preserve the local connection probe, exact CA removal, and side-by-side core onboarding while retaining actual-response verification in a labelled disclosure.
- [x] T010 Reproduce stale core-ready after proxy restart, propagate verification loss, and verify both probe and response-check lifecycles.
