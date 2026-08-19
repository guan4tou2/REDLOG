# RedLog REST API Reference

Complete reference for the HTTP API served by `src/core/api-server.ts`. The API binds `127.0.0.1` on the port written to `~/.redlog/api-port` (default 6660).

## Authentication

All endpoints except `GET /api/health` and `OPTIONS` require a Bearer token:

```
Authorization: Bearer <token>
```

The token is resolved to an `Operator` via `resolveOperatorByToken()`. Primary-only endpoints return `403` when called with a secondary token.

## Security

- **Host allowlist** — only `localhost`, `127.0.0.1`, `[::1]`, `::1`, or empty Host header accepted; everything else gets `400 bad host` (DNS rebinding protection).
- **CORS** — reflects `Origin` only when it matches `^(app|file|http):\/\/(localhost|127\.0\.0\.1|\[::1\])`. No `*`.
- **Sidecar self-heal** — rewrites `~/.redlog/api-token` and `api-port` on every request if either file is missing.

## Endpoint Reference

### Health

#### `GET /api/health`

No auth required. Liveness check.

**Response:** `{ ok: true, version: "<semver>" }`

---

### MCP

#### `POST /mcp` (also `/api/mcp`)

MCP over Streamable HTTP (JSON-RPC 2.0). Accepts a single message or a batch array. Returns `202` with empty body when no responses are produced.

See [agent-integration.md § MCP tools](agent-integration.md#available-tools) for the 18 tool definitions.

---

### Identity

#### `GET /api/whoami`

**Response:**
```json
{
  "operator": { "id": "...", "name": "...", "isPrimary": true, "createdAt": 0, "revokedAt": null },
  "engagementId": "client-pentest-q3"
}
```

---

### Events

#### `POST /api/events`

Primary event ingestion. The server strips any `operator_id` from the body (attribution comes from the Bearer token only).

**Body:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_type` | string | `"external"` | Event source: `shell`, `scanner`, `agent`, `dns`, `credential_use`, `c2_checkin`, `file_transfer`, `marker`, `loot`, `system` |
| `data` | object | `{}` | Event payload. Shell events expect `command`, `subtype` (`command_start`/`command_end`), etc. |
| `target_id` | string | — | Target host/IP |

**Auto-processing for `shell` events:** target extraction, scope violation checks, pivot detection (ssh -D/-L/-R, chisel, ligolo, proxychains, socat), cleanup detection (history -c, shred, etc.), file transfer detection, loot scanning, plugin command tagging, redaction.

**Responses:** `201` (created), `200` (recording paused — event skipped), `409` (duplicate within dedup window).

#### `GET /api/events`

**Query params:** `agent_type`, `limit` (default 100), `since`, `before`, `target_id`

**Response:** `{ count: number, events: Event[] }`

#### `GET /api/events/search`

**Query params:** `q` (min 2 chars), `limit` (default 100)

**Response:** `{ count: number, events: Event[] }`

#### `GET /api/events/count`

**Response:** `{ count: number }`

---

### Markers

#### `POST /api/marker`

**Body:** `{ title, notes?, severity?, category?, target_id? }`

Defaults: `title` → `"Untitled"`, `severity` → `"info"`, `category` → `"external"`.

**Response:** `201` with the created event.

---

### QuickMarks

#### `GET /api/quickmarks`

**Response:** `{ quickmarks: QuickMark[] }`

#### `POST /api/quickmarks`

**Body:** `{ title, url?, note?, context? }`

**Response:** `201` with the created quickmark.

---

### Loot

#### `POST /api/loot/scan`

**Body:** `{ text, targetId?, source? }`

**Response:** `{ findings: [{ type, value, confidence }] }` or `503` if detector unavailable.

---

### Screenshot

#### `POST /api/screenshot`

**Response:** `{ captured: boolean, filePath: string | null }` or `503`.

---

### Status

#### `GET /api/status`

**Response:** `{ ip: IPStatus | null, eventCount: number, scopeViolations: number, capture: CaptureHealth }`

#### `GET /api/capture`

**Response:** Detailed capture health metrics.

---

### Configuration

#### `GET /api/config`

**Response:** Full engagement configuration object.

---

### Scope

#### `GET /api/scope`

**Response:** `{ configured: boolean, targets: string[], violations: object[], violationCount: number }`

---

### Recording

#### `GET /api/recording`

**Response:** `{ recording: boolean }`

#### `POST /api/recording`

**Body:** `{ action: "pause" | "resume" | "toggle" }` (defaults to `"toggle"`)

**Response:** `{ recording: boolean }`

---

### Operators

#### `GET /api/operators`

**Response:** `{ operators: [{ id, name, isPrimary, createdAt, revokedAt }] }`

#### `POST /api/operators` (primary only)

**Body:** `{ name, id? }`

**Response:** `201 { operator, token }` — token is returned **once**.

#### `PATCH /api/operators/:id` (primary only)

**Body:** `{ name }`

**Response:** `{ renamed: boolean }`

#### `POST /api/operators/:id/rotate` (self or primary)

**Response:** `{ token: "<new-token>" }`

#### `POST /api/operators/:id/revoke` (primary only)

**Response:** `{ revoked: boolean }`

#### `DELETE /api/operators/:id` (primary only)

**Response:** `{ deleted: boolean }`

---

### Terminal Replay

#### `POST /api/terminal/replay`

**Body:** `{ eventId }` — ID of a `command_end` event from the builtin terminal.

**Response:** `{ command, exitCode, durationSec, castPath, startMs, endMs, bytes, text, truncated }`

---

### Evidence Chain

#### `GET /api/chain`

**Response:** `{ length: number, lastAnchor: Anchor | null }`

#### `GET /api/anchors`

**Query params:** `limit` (default 50)

**Response:** `{ anchors: Anchor[] }`

#### `POST /api/anchors`

Anchor current chain head immediately.

**Response:** `201 { anchor }`

#### `GET /api/anchors/verify`

**Query params:** `full=1` for full chain walk (async); otherwise latest-anchor prefix check only.

**Response:** Verification result.

#### `POST /api/anchors/upgrade-all`

Fetch upgraded OTS proofs from calendars for all pending anchors.

#### `POST /api/anchors/:id/upgrade`

Upgrade a specific anchor.

**Response:** `{ anchor }` or `404`.

#### `GET /api/anchors/:id/ots`

Download `.ots` proof file.

**Query params:** `calendar` (optional — filter to a specific calendar's receipt)

**Response:** Binary `application/octet-stream` with headers `X-Redlog-Head-Hash` and `X-Redlog-Calendar`.

---

### Clock

#### `GET /api/clock`

**Response:** `{ ntpOffsetMs, lastQueryAt, hostWallMs }`

---

### Export

#### `POST /api/export/bundle`

Produce signed evidence bundle in `<projectDir>/exports/`.

**Response:** `201 { outDir, manifest }`

---

### Sanitize

#### `POST /api/sanitize`

Layer 4 of four-layer redaction.

**Body:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `event_ids` | string[] | required | Events to sanitize |
| `fields` | string[] | `["output", "output_preview", "command"]` | Fields to redact |
| `reason` | string | — | Audit reason |
| `dry_run` | boolean | `false` | Preview without applying |

Writes masked bytes to `sanitized_events` table + appends chained `system.sanitized` event.

---

### Deconfliction

#### `GET /api/deconfliction`

**Response:** Config object with `secret` masked as `"***"`.

#### `POST /api/deconfliction/test`

Send a test payload to the configured webhook.

---

## Endpoint Summary

| Method | Path | Auth | Category |
|--------|------|------|----------|
| GET | `/api/health` | no | Health |
| POST | `/mcp` | yes | MCP |
| GET | `/api/whoami` | yes | Identity |
| POST | `/api/events` | yes | Events |
| GET | `/api/events` | yes | Events |
| GET | `/api/events/search` | yes | Events |
| GET | `/api/events/count` | yes | Events |
| POST | `/api/marker` | yes | Markers |
| GET | `/api/quickmarks` | yes | QuickMarks |
| POST | `/api/quickmarks` | yes | QuickMarks |
| POST | `/api/loot/scan` | yes | Loot |
| POST | `/api/screenshot` | yes | Screenshot |
| GET | `/api/status` | yes | Status |
| GET | `/api/capture` | yes | Status |
| GET | `/api/config` | yes | Config |
| GET | `/api/scope` | yes | Scope |
| GET | `/api/recording` | yes | Recording |
| POST | `/api/recording` | yes | Recording |
| GET | `/api/operators` | yes | Operators |
| POST | `/api/operators` | primary | Operators |
| PATCH | `/api/operators/:id` | primary | Operators |
| POST | `/api/operators/:id/rotate` | self/primary | Operators |
| POST | `/api/operators/:id/revoke` | primary | Operators |
| DELETE | `/api/operators/:id` | primary | Operators |
| POST | `/api/terminal/replay` | yes | Terminal |
| GET | `/api/chain` | yes | Chain |
| GET | `/api/anchors` | yes | Chain |
| POST | `/api/anchors` | yes | Chain |
| GET | `/api/anchors/verify` | yes | Chain |
| POST | `/api/anchors/upgrade-all` | yes | Chain |
| POST | `/api/anchors/:id/upgrade` | yes | Chain |
| GET | `/api/anchors/:id/ots` | yes | Chain |
| GET | `/api/clock` | yes | Clock |
| POST | `/api/export/bundle` | yes | Export |
| POST | `/api/sanitize` | yes | Redaction |
| GET | `/api/deconfliction` | yes | Deconfliction |
| POST | `/api/deconfliction/test` | yes | Deconfliction |
