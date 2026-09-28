# Implementation Plan: HTTP verification attempts

## Technical Context
TypeScript, React, existing Electron event batch and managed-proxy status IPC.
No dependency, database or IPC schema changes. Transient UI state only.

## Constitution Check
Before/after design: pass. Exact response selection enforces Surface Truthfulness;
no evidence mutation; no automatic network or terminal actions. Test-first applies.
Canonical capture lifecycle: docs/domain/SPEC-capture-source-lifecycle.md.

## Design
`src/renderer/src/lib/httpAttempt.ts` owns URL validation, nonce generation,
safe POSIX/PowerShell curl recipes and exact completed-response matching.
`HttpCaptureVerification.tsx` owns four independent client/protocol slots and
60-second timeout, plus explicit generate/copy/retry. Each nonce binds one slot.
`HttpCaptureStep.tsx` owns proxy/config operations. Poll status every two seconds;
confirm status before accepting candidate response. PID/listener change, stopped
or unknown status resets attempts. Component unmount resets local verification.
Keep CA controls; disclose that CA availability does not establish client trust,
and configured browser certificate bypass does not verify OS trust.

## Files / sequence
Tests -> helper -> focused verification component -> parent integration and i18n
-> recovery tests -> desktop journey -> lifecycle contract and verification record.

## Limits
Cooperative named-client test, not client attestation. Operator chooses safe GET
URL. Curl recipe explicitly routes via proxy, does not use -k, has a 30s timeout.
HTTP 100-599 is observed capture, not target success. Real-proxy smoke is required before marking the capture claim Verified.

## Discovered capture defect
The first real HTTPS smoke returned the correct origin body but stored only its
request. A stdlib regression reproduced IPAddress SAN JSON serialization failure
in hooks/mitmproxy-addon.py. Convert SAN values to text (existing event schema),
then repeat the same real proxy and packaged macOS smoke. This is an in-scope
evidence-loss defect, not a new capture engine.

## Main integration

Keep upstream `httpVerification.ts` for the synthetic local probe, and move
actual-response helpers to `httpAttempt.ts`. These prove different things;
neither helper duplicates the other's matcher. `HttpCaptureStep` presents the
local check first and the actual-request check in a labelled disclosure.
Trust/untrust commands use upstream CA fingerprints. Apply proxy identity and
attempt reset in the same state update so a newly displayed nonce is stable.
