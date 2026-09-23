# External terminal session recording

Install the current Bash or Zsh hook through RedLog, then open a new shell.
Python 3 is required. Start an explicitly recorded shell with `redlog-session`,
or one interactive command with `redlog-session -- ssh user@host`.
Use `redlog-session --max-bytes 10485760 -- bash` for a 10 MiB capture cap.

The child receives a PTY and terminal resize events. stdout and stderr are
merged, as on a normal terminal. Input keystrokes are not recorded, but input
that the remote program echoes becomes observable output. No proxy environment
is added to external sessions.

Output is searchable in Search and Transcript, linked by terminalId and sequence.
This is an output-event stream, not asciicast playback. For timed playback use
RedLog's built-in terminal. Outside the recorded child, normal hooks still record command metadata. Inside
it, metadata hooks are disabled to avoid duplicate or cross-project writes.
`redlog-run` remains the separate, per-command stdout/stderr wrapper.

Pause in RedLog suppresses received output; it is never spooled for later
replay. Pause is evaluated when the server receives a chunk; queued output is
not a timestamp-exact privacy boundary. Project identity and credentials are fixed when recording starts.
Switching projects cannot reattribute output. On API failure, queue overflow,
or capture limit, the command remains usable and omitted bytes are disclosed
locally and in the final session event if delivery is possible. If the server
remains unavailable or paused on exit, the terminal explicitly warns that the
closing event could not be recorded. There is no offline output recovery.

The pending queue is bounded to 64 chunks of at most 16 KiB of terminal bytes;
the default session output budget is 50 MiB. Exceeding the budget stops recording
for that session, even if subsequent output becomes smaller.

Supported entry: native macOS/Linux Bash and Zsh. Native Windows uses the
existing PowerShell Start-Transcript integration. WSL-to-Windows transport is
not enabled by this launcher; use the built-in terminal for that path.
