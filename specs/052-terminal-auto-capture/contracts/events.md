# Contract: what the zsh adapter emits

The envelope is the existing one (`hooks/shell-common.sh`): `POST /api/events`
with `agent_type: 'shell'`, a `subtype`, the command string, the bearer token
and the identity block. This contract adds fields and one subtype; it does not
introduce a second transport.

`source` identifies the originating terminal, while `captured_by` identifies
how output was recorded. When `REDLOG_TERMINAL=1`, both command boundaries
retain `source: builtin-terminal` and `terminalId`, including when an automatic
relay captures the bytes. They must not become external-shell evidence merely
because `captured_by` is `auto-relay`; ingest uses the source to attach the pane's
`.cast` range.

## Internal relay completion

The Zsh adapter acknowledges opening both stream PTYs with `opened`. After
restoring its original descriptors, it writes `closed`: EOF/EIO before this
boundary must not close a master that the command may still write to. The
recorder waits without spinning; an exited owner also ends the interval.

A suspended/background job can outlive the foreground drain deadline. Removing
the work directory retires the evidence interval; it must not interrupt that
job's terminal output or recreate retired part files. The existing incomplete
drain disposition remains authoritative; late forwarding is not proof that
all bytes were retained. The explicit session recorder uses its child exit
status as the corresponding boundary, rather than this adapter marker.

## `command_start`

Already emitted. Gains:

```jsonc
{
  "subtype": "command_start",
  "source": "auto-relay",        // "auto-relay" | "auto-pty" | "builtin-terminal" | absent (hook metadata only)
  "session_id": "<terminal session>",
  "command_id": "<new per command>",   // NEW — the correlation key
  "class": "relayed",            // NEW — relayed | pty | native
  "cwd": "/root"
}
```

## `command_output` (NEW subtype)

One per chunk. Correlated **only** by identifiers; nothing in `bytes` is ever
read to decide where a chunk belongs (FR-002).

```jsonc
{
  "subtype": "command_output",
  "session_id": "<terminal session>",
  "command_id": "<command>",
  "seq": 3,                      // ordering within the command
  "stream": "stdout",            // stdout | stderr, kept separate
  "bytes_b64": "...",            // raw as captured
  "truncated": false,
  "bytes_total": 4096            // before any bound was applied
}
```

An ingested chunk whose `command_id` matches no open command is stored with
`unattributed: true` rather than dropped (background output, FR-007).

## `command_end`

Already emitted with `exit_code`, `duration_sec`, `cwd`. Gains:

```jsonc
{
  "subtype": "command_end",
  "command_id": "<command>",
  "completeness": "full",            // full | truncated | metadata-only | partial
  "output_disposition": "captured",  // captured | redirected | interactive | not-captured | project-boundary
  "limit_hit": null                  // e.g. "stdout:102400" when truncated
}
```

**Ordering rule**: `command_end` is written only after the relay has flushed
every chunk for that `command_id`. The receiver orders by `seq`, never by
arrival time (research O2).

## `session_start` / `session_end`

Already emitted by the adapter's announce. Gains the pinned `engagement_id` and
`operator_id` for the terminal, so a project switch can be detected by
comparison rather than inferred.

## Failure and degradation

| Situation | What is emitted | What the operator sees |
|---|---|---|
| RedLog unreachable | nothing now; payload spooled to `~/.redlog/pending` | nothing — the spool replays on next open |
| Relay cannot run | `command_start`/`command_end` with `output_disposition: not-captured` | "recording stopped", once |
| Recording stopped by operator | nothing for that command | the terminal's status says stopped |
| Project switched under an open terminal | `session_end` with a reason | "this terminal was recording project X; it has stopped" |

Nothing in this table is silence. Principle VI: no-event, not-captured,
stopped, and failed stay distinct all the way to the timeline.
