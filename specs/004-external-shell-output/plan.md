# Implementation Plan

## Constitution Check

- Preserve the existing event payload and truncation contract.
- Label metadata-only capture truthfully instead of implying stdout coverage.
- Keep the shell integration optional and recorder failure non-blocking.
- Use the existing Bash hook, Capture Health card and i18n system.

## Canonical Interfaces

- `redlog-run` remains the explicit one-command output-capture entry point.
- `CaptureHealthCard` remains the source-capability presentation surface.
- `_redlog_send_event` remains the hook transport and spool boundary.

## Phases

1. Add a failing POSIX integration test proving output is buffered today.
2. Stream both command streams live while retaining separate capture files.
3. Add concise Capture Health capability text and render coverage tests.
4. Update operator documentation and run typecheck, build and desktop smoke.

## Deliberate Boundary

A sourced preexec hook cannot safely and transparently interpose every command's
PTY streams. This feature improves the explicit wrapper and tells the truth
about the default; session-wide PTY recording requires a separate design.
Splitting lifecycle integration into thin bash, zsh, fish and PowerShell
adapters over a shared sender is also a separate refactor so transport and
spool semantics are not duplicated during this behavior change.
