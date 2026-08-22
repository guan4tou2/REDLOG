# Traffic Capture Design

RedLog's traffic capture pipeline, implemented via the mitmproxy addon
(`hooks/mitmproxy-addon.py`) and the REDLOG API server
(`src/core/api-server.ts`), provides Burp Suite-equivalent visibility for
red-team operations.

## Architecture

```
mitmproxy (proxy)          RedLog API server            Storage
─────────────────          ─────────────────            ───────
request()        ─POST─>   /api/events                  events_logged (SQLite)
response()       ─POST─>     ├─ extractBodyToSidecar()   http-bodies/<sha256>.body
websocket_message()          ├─ credential detection      (sidecar, >4KB)
tcp_message()                ├─ redaction scan
dns_message()                ├─ scope signal dispatch
error()                      └─ insertEvent()
```

All scanner/dns events go to the **logged tier** (`events_logged` table) — no
hash chain, no signature, subject to retention sweep. This keeps the chained
tier lean for audit integrity.

## Capture Channels

### HTTP (request + response)

| Hook | Subtype | Tier | Fields |
|------|---------|------|--------|
| `request()` | `http_request_start` | logged | method, url, host, port, scheme, ALL headers, params, full body, body preview, http_version, stream_id, cookies |
| `response()` | `http_response` | logged | status, ALL headers, full body, body preview, content_type, content_length, duration_ms, TLS info (+ JA3), timing breakdown, http_version, stream_id, set_cookies |
| `error()` | `http_error` | logged | error message, request headers, duration_ms |
| `_sweep_stale()` | `http_request_dropped` | logged | flow_id, age_sec (>300s without response) |

**Body capture**: Full bodies up to `MAX_BODY` (default 10 MB). SHA-256 hash
computed on the stored (possibly truncated) bytes. Bodies >4 KB are extracted
to sidecar files (`http-bodies/<sha256>.body`); the event carries a `BodyRef`
pointer. Base64 encoding for binary content.

**Headers**: All headers captured as ordered `[[name, value], ...]` arrays,
preserving duplicates (e.g. multiple Set-Cookie) and original casing. Capped
at `MAX_HEADERS` (default 200) to prevent pathological bloat.

**Body decode safety**: `flow.response.content` access is wrapped in
try/except — corrupted gzip/brotli responses still emit an event (without
body) rather than being silently lost.

### WebSocket

| Hook | Subtype | Tier | Fields |
|------|---------|------|--------|
| `websocket_message()` | `ws_message` | logged | flow_id, url, host, direction (client/server), message_type (text/binary), size, message_count, full payload, preview |

Shares the same body capture pipeline (sidecar extraction, SHA-256). Each
frame is a separate event. High-frequency channels (e.g. Socket.IO heartbeat)
may produce many events — logged tier + retention handles volume.

### TCP Streams

| Hook | Subtype | Tier | Fields |
|------|---------|------|--------|
| `tcp_message()` | `tcp_message` | logged | flow_id, host, port, direction, size, message_count, tls_version (if TLS), full payload, preview |

Requires mitmproxy TCP mode (`--mode tcp@port` or transparent). Each message
chunk is a separate event.

### TLS Handshake

TLS information is extracted from completed HTTP flows and attached to the
`http_response` event as a `tls` object:

```json
{
  "tls": {
    "tls_version": "TLSv1.3",
    "cipher": "TLS_AES_256_GCM_SHA384",
    "alpn": "h2",
    "cert_subject": "CN=example.com",
    "cert_issuer": "CN=R3, O=Let's Encrypt",
    "cert_san": ["example.com", "*.example.com"],
    "cert_serial": "04:..."
  }
}
```

Extracted via `flow.server_conn` properties: `tls_version`, `cipher`,
`certificate_list`, `alpn`. Only present for HTTPS flows.

### JA3 Fingerprint

The `tls_clienthello` hook computes JA3 from the raw ClientHello:

```json
{
  "tls": {
    "ja3": "e7d705a3286e19ea42f587b344ee6865",
    "ja3_raw": "771,4866-4867-4865-49...(truncated at 500 chars)"
  }
}
```

JA3 hashing: MD5 of `TLSVersion,Ciphers,Extensions,EllipticCurves,ECPointFormats`
with GREASE values (0x?a?a) filtered out. Cached by client peername address
(cache evicts oldest 1000 entries when exceeding 5000). Attached to the
`http_response` tls object since `tls_clienthello` fires before HTTP hooks.

### HTTP/2 Stream ID

HTTP version and stream ID are captured for every request and response:

```json
{
  "http_version": "HTTP/2.0",
  "stream_id": 13
}
```

Extracted from `flow.request.http_version` and `flow.request.stream_id`.
Useful for correlating multiplexed HTTP/2 streams.

### Cookie Tracking

Request cookies are extracted from the `Cookie` header into structured form:

```json
{
  "cookies": [{"name": "session", "value": "abc123"}]
}
```

Response `Set-Cookie` headers are parsed with all attributes:

```json
{
  "set_cookies": [{
    "name": "session", "value": "xyz789",
    "path": "/", "domain": ".example.com",
    "secure": true, "httponly": true, "samesite": "Lax"
  }]
}
```

Session cookie rotations (names matching session/sessionid/sid/jsessionid/
phpsessid/token/auth_token/access_token/csrf/xsrf) trigger a
`scanner:cookie_change` companion event with SHA-256 hashed old/new values
(raw cookie values are never stored in the event).

### Timing Breakdown

Per-flow timing attached to `http_response` as a `timing` object:

```json
{
  "timing": {
    "connect_ms": 12,
    "tls_ms": 45,
    "send_ms": 1,
    "wait_ms": 230,
    "receive_ms": 15,
    "total_ms": 303
  }
}
```

Extracted from mitmproxy's `server_conn.timestamp_*` and
`request/response.timestamp_*` properties.

### DNS

| Hook | Subtype | Tier | Fields |
|------|---------|------|--------|
| `dns_message()` → `_dns_query()` | `dns_query` | logged | query_name, query_type, query_id, transport, source_addr |
| `dns_message()` → `_dns_response()` | `dns_response` | logged | response_code, answers, duration_ms, _causes → query event |

Requires mitmproxy DNS mode (`--mode dns@53`).

## Body Storage Pipeline

```
mitmproxy addon                   API server                    Disk
───────────────                   ──────────                    ────
_capture_body()                   extractBodyToSidecar()
  ├─ truncate to MAX_BODY           ├─ shouldExternalize()
  ├─ sha256 (post-truncation)       │    (>4096 chars?)
  ├─ text → "encoding":"text"       ├─ storeBody()
  └─ binary → base64                │    ├─ sha256 of actual bytes
                                    │    ├─ filename: <sha256>.body
                                    │    └─ dedup: skip if exists
                                    └─ replace data[field] with BodyRef
```

**Sidecar pattern**: Same as `.cast` files for terminal sessions. The event
row in SQLite carries only a lightweight `BodyRef`:
```typescript
{ sha256: string; size: number; file: string; encoding: 'text' | 'base64' }
```

The UI loads full bodies on demand via `window.redlog.httpBody.read(ref)`.

**Retention**: `sweepRetention()` sweeps `http-bodies/` alongside casts and
screenshots. Default keepDays = 0 (keep forever unless configured).

## Companion Event Detection

### Credential Use (auto-detected)

When an `http_request_start` event carries authentication indicators, a
companion `credential_use` event is emitted to populate the dedicated lane:

| Pattern | Method | MITRE |
|---------|--------|-------|
| `Authorization: Basic ...` | `basic_auth` | T1078 |
| `Authorization: Bearer ...` | `bearer_token` | T1078 |
| `Authorization: NTLM ...` | `ntlm` | T1078 |
| `Authorization: Negotiate ...` | `negotiate` | T1078 |
| `Cookie:` with session/token/auth/jwt/sid | `session_cookie` | T1078 |
| `X-API-Key` / `API-Key` header | `api_key` | T1078 |
| Request body containing password/passwd/credential | `form_login` | T1078 |

### Cookie Change (auto-detected)

When a `Set-Cookie` in an `http_response` rotates a tracked session cookie
(new value differs from the last seen value for the same name+domain), a
companion `scanner:cookie_change` event is emitted:

```json
{
  "subtype": "cookie_change",
  "domain": ".example.com",
  "cookie_name": "session",
  "old_hash": "sha256:...",
  "new_hash": "sha256:...",
  "flow_id": "abc123"
}
```

Tracked cookie names: session, sessionid, sid, jsessionid, phpsessid, token,
auth_token, access_token, csrf, xsrf. Only SHA-256 hashes are stored.

### Scope Signals

The scope/alert system receives signals from:
- `http_request_start` → target host
- `ws_message` → target host
- `tcp_message` → target host
- `dns_query` → query name
- `shell.command_start` → detected target

## Redaction

The following fields pass through the four-layer redaction scanner:
- `output`, `output_preview`, `command`, `stdout`, `stderr`
- `request_body_preview`, `response_preview`
- `ws_preview`, `tcp_preview`

Full body content (in sidecar files) is **not** redacted — the sidecar stores
raw bytes for forensic fidelity. Redaction spans are detected on preview
fields so the UI can mask them.

## HAR Export

`GET /api/export/har` returns a HAR 1.2 JSON file with all HTTP flows
paired by `flow_id`. Includes request/response headers, bodies (resolved
from sidecar if needed), and timing breakdown.

IPC bridge: `window.redlog.har.export(opts)` — available in the renderer.

Query params: `since`, `before`, `target_id`, `limit`.

## Spool Recovery

When the API server is unreachable, the mitmproxy addon (and shell hooks)
spool payloads to `~/.redlog/pending/*.json`.

Recovery runs at two points:
1. **Project open** — drains all pending files immediately
2. **Every 30 seconds** — periodic timer drains up to 200 files per tick

Recovered events are stamped with `recovered_from_spool: true`.

## Configuration

### Environment Variables (mitmproxy addon)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDLOG_MAX_BODY` | `10485760` (10 MB) | Max body bytes before truncation |
| `REDLOG_PREVIEW_BODY` | `4096` | Inline preview length |
| `REDLOG_MAX_HEADERS` | `200` | Max headers per request/response |
| `REDLOG_SKIP_STATIC` | `false` | Skip .css/.js/.png/.woff etc. |
| `REDLOG_VERBOSE` | `false` | Log every event to stderr |

### API Server Constants

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_REQUEST_BYTES` | 20 MB | `api-server.ts` — reject oversized POST bodies |
| `INLINE_THRESHOLD` | 4096 | `http-body-store.ts` — bodies larger than this go to sidecar |

## Request/Response Paired View

When an HTTP request or response is selected in the Timeline detail panel,
the paired event is auto-fetched by `flow_id` via `events:queryByFlowId`
and rendered inline. The request shows the partner response's status/headers/
body preview, and vice versa — no need to find two events manually.

The query runs against `events_logged` with `LIKE '%"flow_id":"<id>"%'`.

## HTTP History Panel

A dedicated sidebar view (`http_history`) provides a Burp Suite-style table
of all HTTP flows:

| Column | Source |
|--------|--------|
| Method | `request_headers` → first request event |
| Status | `response` event status |
| Host | `host` field |
| URL | `url` field (shows path + query only in table) |
| Type | `content_type` (shortened) |
| Size | `content_length` |
| Time | `duration_ms` |
| When | `timestamp` |

Flows are built by grouping scanner events by `flow_id`. Filters: method
chips, status class (2xx/3xx/4xx/5xx), free-text URL/host/type. Sortable by
status, size, duration, or time. Clicking a row jumps to the Timeline detail.

Two view modes via a toggle in the header bar:
- **Table** — flat list of all HTTP flows (default)
- **Sitemap** — collapsible tree organized by host → path segments. Each
  node shows the HTTP methods, status codes, and flow count. Leaf nodes
  (single endpoint) click-through to Timeline. Mirrors Burp Suite's
  Target > Site map.

## Proxy Bypass Detection

`proxy-bypass-detector.ts` monitors process spawns for known network tools
(curl, nmap, sqlmap, nuclei, ffuf, etc.). After a 15-second delay, it checks
whether any scanner traffic appeared during that tool's runtime. If not, a
`system.proxy_bypass_suspected` event is emitted.

This is heuristic — false positives are possible (tool may use a different
protocol, or the mitmproxy addon hasn't forwarded the events yet). The
advisory surfaces on the system lane so the operator sees it.

Known network tool binaries are maintained in `NETWORK_TOOLS` set. Generic
runtimes (python, ruby, node, java, go) trigger detection only when their
command line contains HTTP-related library references.

## Known Limitations

1. **No UDP/ICMP capture** — DNS (via mitmproxy DNS mode) is the only
   UDP protocol. ICMP and other UDP tools show only in shell events.

2. **CDP capture requires Chromium** — Browser console/navigation events
   require Chrome launched with `--remote-debugging-port`. Non-Chromium
   browsers are not supported.
