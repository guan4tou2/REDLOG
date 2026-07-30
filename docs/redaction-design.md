# Redaction: capture full, sanitize on export

RedLog's redaction is currently **capture-time destructive**: high-entropy tokens in the raw text get replaced with `[REDACTED_ENTROPY_x.x]` placeholders before the event lands in the DB ([src/core/redaction.ts](../src/core/redaction.ts)). The span offsets are kept in a sibling `redactions` field, but the original bytes are gone.

For an evidence tool this is the wrong default. Redaction at capture is a lossy edit of the record before the hash chain closes over it — the exact thing the chain exists to prevent. False positives can't be un-redacted; investigators can't answer "what actually came out of that command"; and a sanitized entry looks identical to a genuinely empty one.

This note describes the intended layering: capture the full text, mark sensitive spans as metadata, hide them in the UI, and only rewrite bytes at export time — with the sanitization itself recorded as a chained event.

## The four layers

```
┌────────────────────────────────────────────────────────────┐
│ Layer 1: capture — full raw text, into SHA-256 chain       │  never mutated
├────────────────────────────────────────────────────────────┤
│ Layer 2: detect — loot / entropy scan produces spans       │  metadata only
│   event.redactions: [{start, end, field, type, reason}]    │
├────────────────────────────────────────────────────────────┤
│ Layer 3: display — UI masks spans; explicit reveal action  │  no byte change
│   reveal → append system.secret_revealed event             │
├────────────────────────────────────────────────────────────┤
│ Layer 4: export — cli sanitizes bytes for delivery bundle  │  new bytes, source untouched
│   append system.sanitized event; ship replacement copy     │
└────────────────────────────────────────────────────────────┘
```

Every layer above 1 is additive: it never edits an existing event's fields, only appends new events.

## Layer 1 — capture

No change to intent, one change to `redact()`: return the original text and the span list, drop the placeholder substitution. Callers that want the masked view compose it themselves from `text + redactions`.

Effect on the on-disk record: raw command output lands in `events.data.output` byte-for-byte. The hash chain closes over the true text.

## Layer 2 — detect

Detection already runs. The only change is that its output is metadata, not a rewrite:

```ts
event.redactions = [
  { field: 'output', start: 120, end: 160, type: 'entropy', reason: '5.1 bits/char, 40 chars' },
  { field: 'output', start: 300, end: 340, type: 'denylist', reason: 'aws_access_key_id' },
]
```

The Loot detector keeps its current path — the extracted value goes to the Loot Panel as before, with a pointer back to the source event.

## Layer 3 — display

Timeline card and detail view mask spans by default (`••••••••` sized to the span). A per-event "Reveal" action shows the underlying bytes; using it appends:

```
event_type: system.secret_revealed
data: { source_event: "...", field: "output", spans: [...], viewer: "<operator>" }
```

This event is chained like any other. A reviewer can tell that raw values were viewed, by whom, and when — without preventing legitimate viewing.

## Layer 4 — export sanitization

The delivery bundle is the point where actual byte replacement happens.

```
redlog-cli sanitize <oplog> --fields output,command --dry-run
redlog-cli sanitize <oplog> --fields output,command --confirm
redlog-cli export bundle <oplog> --sanitized
```

For each sanitized event the CLI writes a **replacement record** to a separate `sanitized_events` table (not an UPDATE on `events`), and appends a chained event:

```
event_type: system.sanitized
data: {
  source_events: ["..."],
  fields: ["output", "command"],
  operator: "<who ran the CLI>",
  reason: "pre-delivery scrub",
  replacement_hash: "<sha256 of the sanitized bytes>",
}
```

The exported bundle serves the sanitized copies; the source DB and hash chain are unchanged. `ots verify` on the bundle still passes because the underlying events weren't touched — the bundle just carries a redirect layer plus the `system.sanitized` events proving the redirection happened intentionally.

## What this catches vs doesn't

**Catches**
- Silent redaction after the fact — sanitization always produces a chained `system.sanitized` event; a bundle without matching events is detectable.
- False-positive entropy hits — the raw bytes are still on the source machine; the operator can un-hide them without losing chain integrity.
- Reveal-by-stealth during a review — every reveal appends a `system.secret_revealed` event.

**Doesn't catch**
- An attacker with local FS access still reads the raw DB. Mitigate with disk-level encryption (FileVault / BitLocker); DB-level envelope encryption for span contents is possible later but out of scope here.
- An operator who both sanitizes AND rewrites the chain from scratch (Layer 1 problem, not Layer 4). OpenTimestamps anchoring covers this — see [audit-trail.md](audit-trail.md).

## Migration

- `redact()` in [src/core/redaction.ts](../src/core/redaction.ts): stop substituting placeholders, keep returning span list.
- [src/core/api-server.ts:362](../src/core/api-server.ts:362) already writes `data.redactions`; it just needs to also stop overwriting the source field.
- Config key `redaction.storePreview` becomes a display-layer setting (default: mask on).
- Add event types `system.secret_revealed`, `system.sanitized` to [docs/event-schema.md](event-schema.md).
- New table `sanitized_events(source_event_id PRIMARY KEY, field, sanitized_value, replacement_hash, created_at, oplog_sanitized_event_id)`.
- New CLI subcommand `redlog-cli sanitize`.

**Backward compatibility:** rows already written with placeholder text stay as-is; there's no way to recover the original bytes. Only new events benefit. The config change is silent — behaviour differs from the release forward.

## Prior art

Ghostwriter's [`OplogSanitization`](https://github.com/GhostManager/Ghostwriter/blob/master/ghostwriter/oplog/models.py) records `sanitized_at`, `sanitized_by`, and `fields` per sanitization pass — same idea, applied to a shared-server model. RedLog's variant adds the append-only chained-event property so the record of sanitization survives DB-level rewrites.
