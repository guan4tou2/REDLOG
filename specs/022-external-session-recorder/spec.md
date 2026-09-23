# Feature Specification: Explicit External Session Recording

**Status**: Verified

## Requirements

- Launch `redlog-session [command args...]` explicitly in Bash/Zsh on macOS/Linux.
- Give the child a real PTY, preserve merged output, terminal size, interactive
  control characters and exit status. Record output only, never input keystrokes.
- Stream bounded output events through existing ingest with a stable session ID,
  sequence, occurrence time and explicit start/end boundaries.
- Respect server pause; never spool paused output. Bound queued data and total
  captured bytes. Disconnection, queue overflow and truncation must be visible;
  commands continue even if capture fails.
- Pin the project identity and token at launch. A project switch must reject
  further output rather than write it into the newly active project.
- Do not replace normal shell hooks or claim this is transparent capture.

## Clarifications

PTY stdout/stderr are merged by the operating system. Output is searchable
in event text, not an asciicast replay. Remote commands are observed as terminal
output, not falsely labelled as individually instrumented commands. Native
PowerShell keeps its existing Start-Transcript path; WSL cross-host transport
and native Windows PTY recording require separate platform verification.

Pause is evaluated at server receipt, matching existing producer semantics.
The bounded queue does not promise timestamp-exact exclusion at pause edges.
Normal metadata hooks are disabled inside the recorded child to prevent an
independent unpinned sender from bypassing session identity. Explicit omissions
appear locally and in the final event where delivery succeeds.

## Deferred product scope

No per-target workspace, parallel long-session database, inferred pivot route,
or new general plugin framework. Existing terminal/session IDs are sufficient.
