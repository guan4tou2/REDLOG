# Feature Specification: Recording-first setup

**Feature Branch**: `feat/recording-first-shell-setup`
**Created**: 2026-10-17
**Status**: Draft

## Approved scope

Implements the first installation/setup slice of issue #317 (2026-10-17).
External terminals are primary; the built-in terminal remains an explicit
fallback. Support Bash, Zsh and PowerShell adapters with detected recommendation
and manual selection. WSL remains an environment with its own installation.
A selected adapter must determine prerequisites, activation and nonce proof;
old requests and another adapter's events must not mark it connected.

The command card describes historical project evidence, independently of the
recent activity window. That proof is not a claim that output was recorded or
that a source is currently healthy. Reads that fail must offer recovery.

One web card is verified by HTTPS; HTTP alone must not mark it verified. HTTP
capture remains supported. Nonce, endpoint, CA and client-policy changes must
invalidate inappropriate proof. Capture-browser certificate bypass must remain
explicit. Missing optional web dependencies must not block shell setup.

## Acceptance criteria

- AC1: A supported detected shell can be changed manually. Install and canary
  verification use the selection; unsupported/missing prerequisites are honest.
- AC2: Switching selection during installation or waiting does not accept stale
  responses or another shell's nonce event. Errors offer retry.
- AC3: Ordinary Zsh automatic output is described accurately. Metadata-only
  routes do not promise output. Existing recorded-output verification remains.
- AC4: Twenty-five newer markers/session records cannot remove historical
  command proof. Empty/other project databases and query failure remain distinct.
- AC5: HTTP-only stays unverified, HTTPS alone verifies the web card. Retry and
  proxy/CA changes reset proof, and the parent readiness resets too.
- AC6: Initial setup offers external terminal first and opens the built-in pane
  only on request. Shell setup works without mitmproxy; web preparation is
  explicitly reachable when requested. Narrow windows can finish the flow.

## Boundaries and follow-up

This slice does not implement the separately approved web-only scope/export
policy, optional-source default changes, PowerShell transcript consolidation,
arbitrary executable/profile installation, plugin diagnostics or release work.
Those remain in #317, #341, #347 and #348 and must not be marked completed by
this change. Existing scope/export contracts still apply until their own
specification and regression changes land.

## References

- `.specify/memory/constitution.md`: Evidence Integrity, Surface Truthfulness,
  Query Completeness, Explicit Failure, Risk-Based Test-First Verification.
- `docs/domain/SPEC-capture-source-lifecycle.md`
- Specs 005, 037, 039, 042, 047 and 052; this change supersedes their initial
  built-in-first presentation and HTTP prerequisite, not evidence provenance.
- Issues #317, #340, #341, #342, #343.
