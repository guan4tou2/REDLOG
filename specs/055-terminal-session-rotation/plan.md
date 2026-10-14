# Plan: preserve panes, rotate project recordings

Baseline: main 9f8bf28. No new dependencies or compatibility layer.

The pane ID and PTY live for the lifetime of the shell. Each project binding
gets a distinct recording ID, file, captured identity and byte budget. Project
close finishes all bindings before closing SQLite; project open resumes them
after configuring ingest and recovering genuinely orphaned recordings. Quitting
still kills panes. Opening a picker never writes or replays its activity.

A small synchronous cast writer owns the descriptor and incremental SHA-256.
Small PTY frames are committed in receipt order; closing is a bounded descriptor
close rather than an asynchronous flush followed by a premature file hash.
No read of the accumulated recording is needed at the boundary. Failed writes
close the writer and keep the PTY usable with a persistent failure state.

Continuation metadata uses opaque `{projectId, recordingId}` locators. Command
boundaries add a local companion referring to the local start; the incoming
completion carries an opaque command locator. Foreign event IDs, `_causes` and
cast paths never enter another project's evidence. This clarifies FR-005 versus
FR-006/015: descriptive origin locators are allowed; foreign evidence links are
not. Source rows remain immutable.

Built-in zsh uses the pane's enrollment ID, and only RedLog repins that owned
pane. External shells retain Spec 052's stop-on-switch rule. Ingest synchronously
hands owned command starts/ends to the pane lifecycle, before publishing; casts
and causal offsets reset at the segment boundary. A late completion is marked
as crossing the boundary, rather than borrowing a foreign start or byte range.

The picker exposes surviving panes with a persistent not-recording banner;
it cannot create new panes without a project. The same state is shown on the
pane and in capture health after recording failure. Leave confirmation names
recording cessation and pane survival, without an irreversible-job-loss checkbox.

Validation: real SQLite and cast bytes with mocked PTY callbacks; A→picker→B→A,
in-flight commands, failure, pause, truncation, orphan recovery, shutdown and
ten panes. Electron interaction must prove unchanged pid/cwd, picker output
exclusion, independent chain verification and replay. Platform installer
acceptance remains separate; do not claim native Windows or Kali desktop tests.
