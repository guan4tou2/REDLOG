# c2-tailers

Bundled RedLog pack (SPEC-AI-ERA-PLUGINS Gap 2). C2 beacons are an out-of-band
channel the substrate capture never sees — the check-ins, task results and pivots
live in the framework's own log. This follows that log and lands each line on the
RedLog timeline as a `scanner.c2_checkin`, `scanner.c2_task` or `scanner.c2_pivot`
event.

**Trust:** 🟢 declarative. The tailer runs shell-side (out-of-process) and POSTs
to RedLog's local authenticated API — no code runs inside RedLog. It's a
standalone follower rather than an in-RedLog `TailerAdapter` on purpose: the
built-in tailer system is transcript-shaped (agent turns / cwd) and trust-gated,
whereas a C2 log is a raw event stream that should emit scanner events.

## Use

```sh
# Sliver: follow a session/beacon JSON log (best-effort mapping of Sliver's fields)
plugins/c2-tailers/hooks/sliver-tail.sh ~/.sliver/logs/sliver.json

# Any framework: emit the RedLog-C2 JSONL contract to a file and follow it
plugins/c2-tailers/hooks/generic-tail.sh /path/to/c2-events.jsonl
```

The follower starts at the end of the log, so lines already in it are not
imported; add `--from-start` after the path to import them. It polls for
appends every second and re-reads from the start when the file is truncated or
rotated. A line is consumed only once RedLog accepts it: while RedLog is closed
or a post fails, the follower waits on that line and retries it, so nothing
written in the meantime is lost. Those lines are recorded at the time they are
posted, in whichever project is open then. A line RedLog refuses (HTTP 4xx) is
skipped with a message on stderr.

## RedLog-C2 JSONL contract (the `generic` framework)

One JSON object per line. `kind` selects the mapping:

```jsonc
{ "kind": "checkin", "framework": "mythic", "session": "b-01",
  "host": "10.0.0.5", "os": "linux", "user": "root", "is_beacon": true }
{ "kind": "task", "session": "b-01", "host": "10.0.0.5",
  "command": "whoami", "output_len": 12 }
{ "kind": "pivot", "framework": "sliver", "via": "10.0.0.5",
  "route": "10.1.0.0/16" }              // add "closed": true for teardown
```

- `checkin`/`session` → `scanner.c2_checkin` (target = host)
- `task` → `scanner.c2_task`
- `pivot` → `scanner.c2_pivot` (`state: open|closed`, target = `via`). It is
  not a `pivot` event: that type is RedLog's own conclusion from what it
  captured, and the local API refuses it from outside tools.

All fields are the framework's own record, recorded verbatim — not a RedLog
verdict (DESIGN-PRINCIPLES §3). Point any C2's logging/scripting at this contract
to get first-class timeline coverage without a bespoke integration.

## Sliver mapping

The `sliver` framework maps Sliver session/beacon objects
(`ID`/`Name`/`Hostname`/`Username`/`OS`/`RemoteAddress`/`IsBeacon`) to
`c2_checkin`. Exact log schemas vary by Sliver version, so unrecognized lines are
skipped rather than guessed — use the generic contract for full control.
