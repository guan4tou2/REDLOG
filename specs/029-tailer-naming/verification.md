# Verification: Tailer Naming

**Status**: Verified
**Date**: 2026-09-23

## RED

`test/tailer-naming.test.ts` was written after the move and then run against
the pre-change tree (`c22d7db`, in a temporary worktree): both tests failed —
the config had `transcriptTailer` and no `powershellTranscript`, and
`agent-transcript-tailer.ts` existed with no `adapters/claude-code.ts`.

## GREEN

- The PowerShell follower is `powershell-transcript.ts`, configured by
  `powershellTranscript`, with matching functions and Settings strings.
- The Claude Code adapter is `adapters/claude-code.ts`, pure parsing, with
  `overrideClaudeProjectsDir`. `agent-tailer.ts` registers the three adapters
  and parses nothing. `startAgentTailer` (no caller) and the host re-exports
  are gone; tests import from the host and the adapter.
- Both services are on the canonical-ingest boundary list.
- `docs/TESTING.md` §2.12 says the agent tailer is off by default (it said on)
  and lists `powershellTranscript`.

## Evidence

- Agent tailer, PowerShell transcript, canonical-ingest, config and
  hooks-manager suites: 61 pass; naming guard 2 pass.
- Full suite: 196 files pass in the sandbox; `api-server`, `external-session`
  and `shell-redlog-run` need sockets the sandbox refuses and pass outside it —
  21/21.
- Typecheck and production build pass.
