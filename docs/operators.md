# Operators & API tokens

Every event RedLog records carries an `operator_id`. That id is not a label you type into a form — it is resolved server-side from the **API token** the request was made with. Change token → change identity → different attribution in the timeline.

This is the audit-log foundation that lets you answer "who did what" even when several people (or several agents) share one RedLog instance.

## Model

- Each project has an `operators` table stored inside its SQLite DB.
- Each operator has one active `token_hash` (SHA-256 of a 32-byte random token). Plaintext is never stored.
- Exactly one operator is marked `is_primary` — that's the human running the RedLog app on this machine.
- Every other operator is a **secondary operator**: a teammate on another machine, or a distinct agent context (`codex-agent`, `mitmproxy-runner`, `manual-cli`, etc.).
- Every REST / MCP / hook call arrives with `Authorization: Bearer <token>`. The server hashes the token, looks it up in `operators`, and stamps the resolved id onto the event. Unknown or revoked → 401.

## The primary operator

Bootstrapped from `config.operator.{id, name}` when a project opens. Its token is **rotated to a fresh random 32-byte value every time the app starts** and written to `~/.redlog/api-token` (mode 0600). All local hooks read from that file, so they follow the rotation automatically — nothing to reconfigure.

Rotation means: if `~/.redlog/api-token` leaks, the leak self-heals at next app launch.

## Secondary operators

Add one per teammate or per distinct agent context. Do this **before** they need to log anything.

### Add via UI

1. Settings ▸ General ▸ **Operator Tokens** ▸ enter a name ▸ **Add operator**.
2. The token appears in a red banner **once**. Copy it now.
3. Hand it to the teammate over a secure channel (Signal, 1Password share, in-person).

### Add via CLI

```bash
redlog-cli operators add "Codex agent"
# → Created: codex-agent-a1b2c3
#   Token (save now — not shown again):
#     <64-hex>
```

### Add via REST (from the primary operator)

```bash
TOKEN=$(cat ~/.redlog/api-token)
PORT=$(cat ~/.redlog/api-port)

curl -sX POST http://127.0.0.1:$PORT/api/operators \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Codex agent"}'
# → { "operator": { "id": "codex-agent-a1b2c3", ... }, "token": "<64-hex>" }
```

The `token` in the response is the only time you'll see it in plaintext. Save it.

## Installing a secondary token on another machine

Two options:

1. **Overwrite the token file** (simplest, matches what hooks expect):
   ```bash
   mkdir -p ~/.redlog
   echo -n '<their-64-hex-token>' > ~/.redlog/api-token
   chmod 600 ~/.redlog/api-token
   # api-port needs to be set too if the machine isn't running its own RedLog
   echo -n '6660' > ~/.redlog/api-port
   ```
   Every existing hook (`claude-code-hook.sh`, `redlog-hook.zsh`, `mitmproxy-addon.py`, `redlog-agent.sh`) reads that file, so they now attribute events to the secondary operator.

2. **Environment variable in one specific hook** (leaves the primary token intact for other tools on the same box). Edit the hook to prefer an env var:
   ```bash
   TOKEN="${REDLOG_TOKEN:-$(cat ~/.redlog/api-token)}"
   ```
   then launch just that agent with `REDLOG_TOKEN=<secondary> claude`.

## Rotate a token

Rotation invalidates the old token immediately.

- UI: Operator Tokens list ▸ **Rotate** next to the operator.
- REST:
  ```bash
  curl -sX POST http://127.0.0.1:$PORT/api/operators/<id>/rotate \
    -H "Authorization: Bearer $TOKEN"
  # → { "token": "<new 64-hex>" }
  ```

Rotating the primary operator also rewrites `~/.redlog/api-token`.

## Revoke a token

Softer than deleting: the operator row stays but any request with that token returns 401.

- UI: **Revoke**.
- REST: `POST /api/operators/<id>/revoke` (primary only).

Past events keep pointing at that operator id in the timeline — you want that: audit logs of revoked accounts must remain attributable.

## Delete an operator

Hard delete of the row (primary cannot be deleted from the UI or REST).

- UI: **Delete** (with confirm dialog).
- REST: `DELETE /api/operators/<id>`.

## Verify from an agent

At session start:

```
redlog_whoami
# → { "operator": { "id": "codex-agent-a1b2c3", "name": "Codex agent", "isPrimary": false, ... }, "engagementId": "..." }
```

If the returned name doesn't match who's actually driving the session, you loaded the wrong token — halt and fix before continuing.

## REST reference

| Method | Route | Notes |
|---|---|---|
| GET | `/api/whoami` | Anyone with a valid token |
| GET | `/api/operators` | Anyone with a valid token |
| POST | `/api/operators` | Primary only. Body: `{ "name": "..." }`. Returns token **once**. |
| PATCH | `/api/operators/:id` | Primary only. Body: `{ "name": "..." }` |
| POST | `/api/operators/:id/rotate` | Self or primary. Returns new token **once**. |
| POST | `/api/operators/:id/revoke` | Primary only |
| DELETE | `/api/operators/:id` | Primary only, secondary operators only |

## Threat model — what this does and doesn't protect

**Does protect against:**
- Confusion about which teammate ran a command
- A stolen token being used indefinitely (rotate whenever suspected)
- Deleted / renamed operators erasing their past activity from the timeline (they can't — events keep the old id)

**Does not protect against:**
- Someone with local root on the RedLog machine — they can read the SQLite file, alter `token_hash`, or forge events by writing directly to the DB. Combine with [audit-trail](audit-trail.md) OpenTimestamps anchoring to detect after-the-fact tampering.
- A network attacker on 127.0.0.1 — the API only binds localhost; anyone with local access can read `~/.redlog/api-token`.
- Sharing a token: two people using the same token are indistinguishable in the log. Give each teammate their own.

## Related

- [Skill: redlog-pentest](skills/redlog-pentest.md) — how an agent uses `redlog_whoami` at session start
- [Audit trail](audit-trail.md) — how the chain + OpenTimestamps anchoring works
- [Agent integration](agent-integration.md) — full REST / MCP / hook reference
