# Implementation Plan: Tailer Naming

## Constitution Check

- **Surface Truthfulness**: config keys and Settings strings name the thing
  they control; `docs/TESTING.md` stops saying the agent tailer is on by
  default.
- **Architectural Restraint**: renames and one file split. No behaviour, no new
  knob. The PowerShell follower is NOT moved onto the tailer host: it re-parses
  a whole file and emits shell commands, where the host appends agent turns to
  a chained sidecar; forcing it in would bend both.
- **Risk-Based Test-First Verification**: the existing tailer suites carry the
  behaviour; a guard test pins the names and layout.

## Design

1. `transcript-tailer.ts` → `powershell-transcript.ts`; `configureTranscriptTailer`
   / `stopTranscriptTailer` / `TranscriptTailerConfig` → `…PowershellTranscript…`;
   config key and i18n keys follow.
2. Split `agent-transcript-tailer.ts`: Claude parsing and adapter →
   `adapters/claude-code.ts` (with `overrideClaudeProjectsDir`); registration and
   `configureAgentTailer` / `stopAgentTailer` → `agent-tailer.ts`. Drop the
   unused `startAgentTailer` and the host re-exports; tests import from the host.
3. Rename the test files to match; add both services to the canonical-ingest
   boundary list.
