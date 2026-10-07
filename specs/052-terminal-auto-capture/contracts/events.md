# Contract: what the zsh adapter emits

The envelope is the existing one (`hooks/shell-common.sh`): `POST /api/events`
with `agent_type: 'shell'`, a `subtype`, the command string, the bearer token
and the identity block. This contract adds fields and one subtype; it does not
introduce a second transport.

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
  "completeness": "complete",        // complete | truncated | metadata-only
  "output_disposition": "captured",  // captured | redirected | interactive | not-captured
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
