# Audit trail: hash chain + OpenTimestamps

RedLog's timeline is designed to be **tamper-evident**, not tamper-proof. Anyone with local root on the machine can rewrite the SQLite file — nothing stops that. But three layers make silent rewrites very hard to hide:

1. **Per-event SHA-256 hash chain** — every event's hash covers the previous event's hash. Any single-row edit invalidates every event after it.
2. **Hourly OpenTimestamps anchoring** — the chain head is submitted to public Bitcoin-backed timestamp servers, so an auditor can prove the chain existed at that time from evidence that is not on the operator's machine.
3. **Drift-detection events** — RedLog logs every observable state change of its own configuration and network posture (config edits, recording pauses, IP flips, VPN/DNS changes, scope violations, cleanup commands, pivot closures) as chained events, so a reviewer can distinguish "nothing happened" from "the rules were quietly changed".

## Layer 1: the SHA-256 hash chain

Every row in the `events` table has two fields:

- `hash` — SHA-256 of the event's own fields (id, timestamp, engagement, session, operator, agent_type, hostname, source_ip, target_id, data, prev_hash)
- `prev_hash` — the `hash` value of the previous event in insertion order (or `NULL` for the very first event)

Implemented in [src/core/db/events.ts](../src/core/db/events.ts).

### What this catches

- Deleting an event in the middle → the next event's `prev_hash` no longer matches any predecessor.
- Changing any field of an event → its own `hash` no longer matches, and every event after it needs to be re-hashed too (otherwise their `prev_hash` values diverge).
- Reordering events → same as deletion + insertion.

### What this doesn't catch

- **Full-chain rewrite by an attacker with the code.** They can recompute every hash from scratch. There's no cryptographic asymmetry — the chain is a Merkle-list, not a signature.
- **Prepending or appending events that never happened**, as long as they're consistent.

That's what layer 2 is for.

## Layer 2: OpenTimestamps anchoring

Once an hour (and on-demand), RedLog:

1. Reads the newest event's `hash`.
2. Combines it with the event count and hashes again → **chain head** (32 bytes).
3. POSTs the chain head as a raw digest to three public OTS calendars:
   - `a.pool.opentimestamps.org`
   - `b.pool.opentimestamps.org`
   - `finney.calendar.eternitywall.com`
4. Stores each calendar's response (base64) as a **receipt** in the `chain_anchors` table.

Calendars later fold those digests into Merkle trees that get anchored to the Bitcoin blockchain. Once that happens, the receipt can be upgraded to a full proof that says "this exact 32 bytes existed at or before block N" — provable **without access to the operator's machine**.

Implemented in [src/core/chain-anchor.ts](../src/core/chain-anchor.ts).

### Status values

Each anchor row has a status:

| Status | Meaning |
|---|---|
| `complete` | All three calendars accepted the digest |
| `partial` | At least one calendar accepted |
| `failed` | Zero calendars accepted (offline, DNS, network timeout) |
| `pending` | Reserved for future async retries |

The hourly loop retries any failed head at the next tick. Manual retry:

- UI: Settings ▸ Data ▸ **Timeline Integrity** ▸ **Anchor now**.
- CLI: `redlog-cli chain anchor` (and `redlog-cli chain status` / `chain verify` / `chain anchors`).
- MCP: `redlog_chain_anchor_now`.
- REST: `POST /api/anchors`.

## Layer 3: drift-detection events

Layers 1 and 2 prove the log wasn't edited. Layer 3 makes the log **honest by
construction** — RedLog writes attributed, chained events every time its own
observable state shifts, so a reviewer can distinguish "nothing happened" from
"someone silently changed the rules and then acted". All of these are ordinary
events subject to the hash chain, so an attacker who scrubs them breaks the
chain (layer 1 → layer 2 detection).

| Event | Fires when | Why it matters for review |
|---|---|---|
| `system.recording_paused` / `recording_resumed` | Operator (or an agent) toggles recording | A 20-min timeline gap without a `recording_paused` = operator was idle. With one = the gap is authorized and dated. Since v0.9.5 pause genuinely suppresses capture, so these two rows are the *entire* record of what happened in between — they carry `source` (`ui` / `api` / `mcp`) alongside the usual `operator_id`, so a reviewer can tell an operator pausing from an agent pausing itself |
| `system.config_changed` | Any security-relevant setting saved (scope warn-on-violation/targets/excludeTargets/scopeFile, IP whitelist/blacklist, engagement/operator id, deconfliction endpoint) — with a from→to diff | Silently turning scope warnings off or removing an IP from the blacklist leaves a chained record naming *when*, *by whom*, and *what changed* |
| `system.scope_violation` (own `scope` lane) | Command target falls outside allowed scope | Chained record of every action that RedLog itself flagged as out-of-scope |
| `system.ip_transition` | External IP or safety state (safe/exposed/unknown) changes | VPN dropped mid-op, egress switched pool, IP flipped to EXPOSED — the moment is dated, not only shown in the HUD |
| `system.opsec_state_changed` | VPN interfaces up/down, DNS resolvers, primary MAC, or hostname change (30 s poll) | Proves the tunnel was actually up during a given command, and catches DNS leaks / MAC randomization events |
| `pivot` `subtype: closed` | A foreground pivot's `command_end` lands (duration ≥ 2 s) | Both ends of a tunnel appear in the audit trail, not only when it opened |
| `cleanup` events (own `cleanup` lane) | `history -c`, `journalctl --vacuum`, `wevtutil cl`, `shred`, `touch -t`, `chattr +i` detected in a shell command | NIST SP 800-86 mandates anti-forensics actions be tracked distinctly — buried in a shell row they can hide, on their own lane they can't |
| `system.secret_revealed` | Reviewer clicked "Reveal" on an event with redaction spans (four-layer redaction, layer 3) | Raw secret bytes stay in the chain; a viewer who unmasks them leaves a chained record of *when*, *by whom*, and *which fields* — impossible to peek "silently" during review |
| `system.sanitized` | `redlog-cli sanitize --confirm` wrote a masked copy for pre-delivery scrub (four-layer redaction, layer 4) | Bundle carries sanitized copies of the named fields; a bundle where a field looks masked without a matching `system.sanitized` event is detectably tampered |

The `system.*` and `pivot.closed` events are best-effort — RedLog can't
observe things it can't see (a tunnel closed on the remote side, a config
edit made by bypassing the UI to write `config.yaml` directly). But when RedLog
*does* observe them, they land in the chain like any other event.

## Verifying a receipt independently

You do not need RedLog to verify an anchor. All you need is:

1. The `head_hash` from the `chain_anchors` row (or an export).
2. Any calendar receipt for that hash (base64 in the same row).
3. The [OpenTimestamps CLI](https://github.com/opentimestamps/opentimestamps-client) (`pip install opentimestamps-client`).

RedLog exports **standard `.ots` bundles** — no manual assembly needed:

```bash
# Pick an anchor id (or grab the latest from `redlog-cli chain status`)
redlog-cli chain anchors
# → 2026-07-28T...  complete  3/3  events=1247  head=9f2c...

# RedLog auto-upgrades pending anchors every 6 hours in-app, or on-demand:
redlog-cli chain upgrade --all
# → Upgraded 3/3 pending anchors

# Once at least one calendar receipt is upgraded, exporting produces a
# fully verifiable .ots file — no external `ots upgrade` step needed:
redlog-cli chain export-ots <anchor-id> --out anchor.ots
ots verify anchor.ots
# → Success! Bitcoin block 855123 attests data existed as of 2026-07-28 14:22:11 UTC
```

Upgrade is idempotent — pending calendars are retried, already-upgraded ones are skipped. If you export before upgrade completes, you still get a valid **pending** `.ots` file (verifiable with `ots upgrade anchor.ots && ots verify anchor.ots`).

The bundle uses the standard OpenTimestamps `.ots` file format (magic
`OpenTimestamps\x00\x00Proof\x00` + SHA-256 op + digest + calendar
attestation), so any OTS-aware tooling can consume it.

## Quick self-check

Two levels of check:

**Fast** — `GET /api/anchors/verify` (or `redlog-cli chain verify` / `redlog_chain_verify` in MCP) compares the latest anchor's `event_count` to the current chain length. Detects deletion of events after anchoring in constant time.

**Full re-walk** — `GET /api/anchors/verify?full=1` (or `redlog-cli chain verify --full`) iterates every event in insertion order, recomputes each hash, checks each `prev_hash` pointer, and confirms the walked head matches the anchor's `head_hash`. Detects any modification, deletion, insertion, or reorder — but O(n).

```bash
redlog-cli chain verify --full
# OK — walked 1247 events, hash chain intact
#   current head: 9f2c...
#   anchor match: yes (anchor covers 1200)
```

## Threat model

**Detected by RedLog alone:**
- Editing / deleting / reordering any event after the fact (chain break).
- Any tampering that happens after the latest OTS anchor was submitted, because the anchored head no longer matches (once the calendar bakes the digest into Bitcoin, the tampering timestamp is provably before the anchor time).

**Not detected:**
- Tampering with events in the window between the last anchor and now (up to 1 hour by default). Anchor more often via `redlog_chain_anchor_now` right after critical actions to shrink this window.
- An attacker who compromises RedLog **before** any anchor is made, and who never lets one succeed. The `chain_anchors` table is local and can itself be deleted. Mitigation: export anchors off-machine periodically.
- An attacker who compromises OTS calendars **and** RedLog simultaneously. Bitcoin backs the calendars, so this is expensive and detectable to third parties.
- State changes RedLog can't observe (a pivot closed on the remote side, a `config.yaml` edited directly on disk while the app is closed). Layer 3 catches everything RedLog *does* observe; anything invisible to the process is invisible to the log.

## Retention & export

- All anchors stay in `<project>/timeline.db` for the life of the project.
- **Evidence bundle** (`redlog-cli export bundle`) — produces a self-contained directory with `events.jsonl`, `chain_anchors.json`, `operators.json`, `screenshots/`, `casts/`, `manifest.json` (SHA-256 per file + chain head + latest anchor + signing operator), `manifest.sha256`, and **`manifest.hmac`** (HMAC-SHA-256 of `manifest.json` keyed by the primary operator's `token_hash`; verifiable by anyone with that operator's token via `sha256(token) == token_hash`). Off-machine tampering flips both the SHA and the HMAC. **The bundle carried
`quickmarks.json` until bundleVersion 3.** Those rows were private bookmarks —
never chained, never signed, editable in place, and never opened by the bundled
verifier — so the tampering they permitted was on-machine and pre-export, which
is exactly what the SHA and the HMAC cannot see. They are no longer included.
- Standard `.ots` bundles per anchor via `redlog-cli chain export-ots <id> --out anchor.ots`.

## Clock hardening

Each event carries three time signals:

- `timestamp` / `created_at` — wall clock (can drift or be tampered)
- `monotonic_ns` — process-relative monotonic clock (immune to NTP jumps / manual changes)
- `ntp_offset_ms` — cached offset vs `pool.ntp.org` at insertion time

`verify --full` compares wall-clock and monotonic deltas between adjacent events on the same hostname + session. Any pair whose deltas disagree by more than **5 seconds** is reported as a `clockAnomaly` — hash chain still passes, but an auditor sees the clock jumped (NTP correction, manual change, VM pause/resume, or worse). Cross-machine or cross-session events are skipped since the comparison only makes sense within one clock.

```bash
redlog-cli chain verify --full
# OK — walked 1247 events, hash chain intact
#   current head: 9f2c...
#   anchor match: yes (anchor covers 1200)
#   clock anomalies: 2
#     evt-abc… wall_delta=63400ms mono_delta=412ms diff=62988ms host=op-laptop-01.local
#     evt-def… wall_delta=-1200ms mono_delta=850ms  diff=2050ms  host=op-laptop-01.local
```

## Future work

- Automatic retry with exponential backoff for `failed` anchors instead of only at the next hourly tick.

## Related

- [Agent integration](agent-integration.md) — REST surface
- [Skill: redlog-pentest](skills/redlog-pentest.md) — when to anchor during an engagement
