# c2-tailers

Bundled RedLog pack (SPEC-AI-ERA-PLUGINS Gap 2). C2 beacons are an out-of-band
channel the substrate capture never sees — the check-ins, task results and pivots
live in the framework's own log. This follows that log and lands each line on the
RedLog timeline as a `scanner.c2_checkin` / `scanner.c2_task` or a `pivot` event.

**Trust:** 🟢 declarative. The tailer runs shell-side (out-of-process) and POSTs
to RedLog's local authenticated API — no code runs inside RedLog. It's a
standalone follower rather than an in-RedLog `TailerAdapter` on purpose: the
built-in tailer system is transcript-shaped (agent turns / cwd) and trust-gated,
whereas a C2 log is a raw event stream that should emit scanner/pivot events.
Records only while RedLog is open.

## Use

```sh
# Sliver: follow a session/beacon JSON log (best-effort mapping of Sliver's fields)
plugins/c2-tailers/hooks/sliver-tail.sh ~/.sliver/logs/sliver.json

# Any framework: emit the RedLog-C2 JSONL contract to a file and follow it
plugins/c2-tailers/hooks/generic-tail.sh /path/to/c2-events.jsonl
```

The follower polls for appends every second and restarts cleanly on truncation
or rotation.

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
- `pivot` → a `pivot` event (`subtype: open|closed`), aligned with the built-in
  pivot detector's shape.

All fields are the framework's own record, recorded verbatim — not a RedLog
verdict (DESIGN-PRINCIPLES §3). Point any C2's logging/scripting at this contract
to get first-class timeline coverage without a bespoke integration.

## Sliver mapping

The `sliver` framework maps Sliver session/beacon objects
(`ID`/`Name`/`Hostname`/`Username`/`OS`/`RemoteAddress`/`IsBeacon`) to
`c2_checkin`. Exact log schemas vary by Sliver version, so unrecognized lines are
skipped rather than guessed — use the generic contract for full control.
