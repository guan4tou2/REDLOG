# Event schema

The `events` table only fixes the top-level envelope (id, timestamp, operator, hostname, agent_type, target_id, hash, prev_hash, monotonic_ns, ntp_offset_ms). The `data` column is free-form JSON per agent_type.

To make the timeline both **usable inside RedLog** and **portable to Ghostwriter's Oplog** (the industry-standard red-team activity log), agents should populate a small set of **standard keys** whenever they apply. Extra fields are fine — nothing rejects them.

## Standard keys (align with Ghostwriter Oplog)

| Key | Type | Meaning |
|---|---|---|
| `subtype` | string | Sub-category inside the agent_type (`command_start`, `dns_query`, `credential_use`, `c2_checkin`, …) |
| `command` | string | The exact command / query / API call that was run |
| `output` | string | Output produced (raw or truncated — run through `redlog_loot_scan` first) |
| `output_preview` | string | First N chars of output, safe to display in a summary |
| `tool` | string | Tool name used (`nmap`, `sqlmap`, `burp`, `curl`, `manual`, …) |
| `dest_ip` | string | Destination IPv4/IPv6 |
| `dest_host` | string | Destination hostname |
| `dest_port` | number | Destination port |
| `src_ip` | string | Source IPv4/IPv6 (usually your egress) |
| `user_context` | string | User the action was performed as (`root`, `www-data`, `system`, …) |
| `mitre_ttp` | string \| string[] | ATT&CK technique id(s), e.g. `T1046` or `["T1046","T1595.001"]` |
| `description` | string | Human-readable one-liner for the report |
| `comments` | string | Free-form notes / caveats |
| `sha256` | string | SHA-256 of a payload / dropped file / screenshot |
| `bytes` | number | Byte size of a transfer / payload |
| `severity` | string | `info` / `low` / `medium` / `high` / `critical` — for `marker` and `loot` |

## Standard `agent_type` values

All 15 are first-class Timeline lanes (empty lanes auto-collapse):

**Recorded from operator / agent activity:**
- `shell` — commands captured via hooks or the built-in terminal
- `agent` — Claude Code / Codex tool calls (via MCP)
- `http_navigation` — page loads inside the built-in CDP-connected browser
- `dns` — DNS resolutions and probes (`subtype: dns_query` / `dns_response`)
- `pivot` — tunnel/pivot lifecycle — RedLog auto-detects from shell (see below)
- `screenshot` — desktop captures (periodic + on-demand, SHA-256 hashed)
- `clipboard` — clipboard changes (opt-in; SHA-256 + length always, redacted preview optional)
- `file_transfer` — ingress/exfil — RedLog auto-detects from shell (see below)
- `credential_use` — every attempted / successful credential use
- `c2_checkin` — C2 beacon / callback
- `cleanup` — anti-forensics actions (T1070.\*, T1564.001) — RedLog auto-detects (see below)
- `marker` — human-created finding notes / severity marks
- `loot` — credential/secret detections (auto from output, or explicit via `redlog_loot_scan`)
- `scanner` — mitmproxy / port scan / vuln scan output (open agent_type)

**System / drift-detection:**
- `system` — RedLog's own audit trail. Distinct subtypes:
  - `scope_violation` — command touched a target outside allowed scope (own timeline lane `scope`)
  - `ip_transition` — external IP or safety state (safe/exposed/unknown) changed
  - `opsec_state_changed` — VPN interfaces, DNS resolvers, primary MAC, or hostname changed
  - `recording_paused` / `recording_resumed` — recording was toggled. Carries
    `source`: `ui` (operator at the keyboard), `api` (redlog-cli or another
    local REST client) or `mcp` (an AI agent calling `redlog_recording`).
    While paused RedLog records nothing except `system` and `marker` events —
    see [audit-trail.md](audit-trail.md)
  - `config_changed` — security-relevant setting saved (scope targets, warn-on-violation, IP blacklist…) with a from→to diff
  - `browser_launched` — proxied browser opened
  - `secret_revealed` — reviewer clicked "Reveal" on an event whose data has redaction spans; records `source_event`, `fields`, and the viewing operator (four-layer redaction, layer 3 — see [redaction-design.md](redaction-design.md))
  - `sanitized` — `redlog-cli sanitize --confirm` (or the REST equivalent) wrote sanitized bytes to the `sanitized_events` table for pre-delivery scrub; records `source_events`, `fields`, per-field `replacement_sha256`, and an optional `reason`. Source events are never mutated (four-layer redaction, layer 4)
  - `proxy_bypass_suspected` — network tool spawned without corresponding proxy traffic (heuristic, see [DESIGN-traffic-capture.md](DESIGN-traffic-capture.md))
  - `api_started`, `session_start`, `deconfliction_test` — housekeeping, hidden from Timeline by default

### `pivot` events

RedLog **auto-detects** pivots from shell commands (ligolo-ng, chisel, `ssh -D/-L/-R`,
sshuttle, proxychains, socat) and emits a `pivot` event alongside the command, so
the timeline shows the intermediate node and route — not just the raw command.
Agents can also log them explicitly. Keys:

| Key | Meaning |
|-----|---------|
| `subtype` | `tunnel_start` / `socks_up` / `port_forward` / `route_add` / `agent_connect` / `proxied` |
| `tool` | `ligolo-ng` / `chisel` / `ssh` / `sshuttle` / `proxychains` / `socat` |
| `via` | the intermediate / jump node the pivot goes through |
| `route` | CIDR reachable through the pivot (e.g. `10.10.0.0/16`) |
| `socks_port` | local SOCKS port opened, if any |
| `forward` | raw forward spec (e.g. `8080:10.0.0.5:80`) |
| `mitre_ttp` | `T1090` (Proxy) or `T1572` (Protocol Tunneling) |

```json
{
  "agent_type": "pivot",
  "data": { "subtype": "route_add", "tool": "sshuttle", "via": "jump.corp", "route": "10.10.0.0/16", "mitre_ttp": "T1090" }
}
```

A `pivot` also fires with `subtype: "closed"` when the foreground tunnel's
`command_end` lands (durations ≥ 2s only; backgrounded `-fN`/`&` variants can't
be reliably closed and drop off the HUD via the 30-min recency window instead).

### `cleanup` events (anti-forensics)

Auto-detected from shell commands: history clearing, log wiping (`journalctl
--vacuum`, `wevtutil cl`, `rm /var/log/…`), secure delete (`shred`/`srm`/
`sdelete`/`wipe`), timestomp (`touch -t`, SetMace), file-attribute hiding
(`chattr +i`, `attrib +h`). NIST SP 800-86 requires these tracked distinctly.

| Key | Meaning |
|-----|---------|
| `subtype` | `history_clear` / `log_clear` / `file_shred` / `timestomp` / `attr_hide` |
| `tool` | `shell` / `wevtutil` / `journalctl` / `rm` / `shred` / `touch` / `chattr` / … |
| `target` | the file/path named in the command, if any |
| `mitre_ttp` | `T1070.001` (Win logs) / `T1070.002` (Linux logs) / `T1070.003` (history) / `T1070.004` (shred) / `T1070.006` (timestomp) / `T1564.001` (attr hide) |
| `command` | verbatim command that triggered detection |

### `file_transfer` auto-detection

RedLog auto-emits a `file_transfer` companion event when a shell command matches:
`curl -o/-O` / `wget -O` / `aria2c -o` / `scp` / `rsync` / `sftp` / `python -m
http.server`. Agents can still emit explicit `file_transfer` events via API.

| Key | Meaning |
|-----|---------|
| `subtype` | `download` / `upload` |
| `tool` | `curl` / `wget` / `scp` / `rsync` / `python-http.server` / … |
| `url`, `localPath`, `remotePath` | any of these populated depending on tool |
| `mitre_ttp` | `T1105` (ingress-tool-transfer) for download; `T1041` (exfil over C2) for upload |
| `command` | verbatim command that triggered detection |

### `scanner` events (mitmproxy traffic capture)

Events from the mitmproxy addon go to the **logged tier** (`events_logged`).
See [DESIGN-traffic-capture.md](DESIGN-traffic-capture.md) for the full
pipeline architecture.

#### HTTP subtypes

| Subtype | When | Key fields |
|---------|------|------------|
| `http_request_start` | `request()` hook fires | `method`, `url`, `host`, `port`, `scheme`, `request_headers` (all, ordered), `request_body` / `request_body_ref`, `request_body_preview`, `params`, `flow_id`, `http_version`, `stream_id`, `cookies` |
| `http_response` | `response()` hook fires | `status`, `response_headers` (all, ordered), `response_body` / `response_body_ref`, `response_preview`, `content_type`, `content_length`, `duration_ms`, `tls` object (+ `ja3`, `ja3_raw`), `timing` object, `flow_id`, `http_version`, `stream_id`, `set_cookies` |
| `cookie_change` | session cookie rotation detected | `domain`, `cookie_name`, `old_hash`, `new_hash`, `flow_id` |
| `http_error` | `error()` hook fires | `error`, `request_headers`, `duration_ms`, `flow_id` |
| `http_request_dropped` | stale-flow sweep (>300 s) | `flow_id`, `age_sec` |

Headers are stored as `[[name, value], ...]` arrays preserving duplicates
and casing, capped at `MAX_HEADERS` (default 200).

Bodies larger than `INLINE_THRESHOLD` (4096 bytes) are stored as sidecar
files in `<projectDir>/http-bodies/<sha256>.body` and replaced in the event
with a `BodyRef`:
```json
{ "sha256": "a1b2c3...", "size": 81920, "file": "a1b2c3....body", "encoding": "text" }
```

The `tls` object (HTTPS only):
```json
{ "tls_version": "TLSv1.3", "cipher": "...", "alpn": "h2",
  "cert_subject": "CN=...", "cert_issuer": "...", "cert_san": [...], "cert_serial": "...",
  "ja3": "e7d705a3286e19ea42f587b344ee6865", "ja3_raw": "771,4866-4867-..." }
```

`ja3` and `ja3_raw` are computed from the TLS ClientHello via the
`tls_clienthello` hook. GREASE values are filtered. `ja3_raw` is
truncated to 500 characters.

The `timing` object:
```json
{ "connect_ms": 12, "tls_ms": 45, "send_ms": 1, "wait_ms": 230, "receive_ms": 15, "total_ms": 303 }
```

#### WebSocket subtype

| Subtype | When | Key fields |
|---------|------|------------|
| `ws_message` | `websocket_message()` hook | `flow_id`, `url`, `host`, `direction` (`client`/`server`), `message_type` (`text`/`binary`), `size`, `message_count`, `ws_body` / `ws_body_ref`, `ws_preview` |

Each WebSocket frame is a separate event. Binary payloads use base64 encoding.

#### TCP subtype

| Subtype | When | Key fields |
|---------|------|------------|
| `tcp_message` | `tcp_message()` hook | `flow_id`, `host`, `port`, `direction`, `size`, `message_count`, `tls_version` (if TLS), `tcp_body` / `tcp_body_ref`, `tcp_preview` |

Requires mitmproxy `--mode tcp@port` or transparent mode.

#### Auto-detected `credential_use` companion

When `http_request_start` carries authentication indicators, a companion
`credential_use` event is emitted with `_causes` pointing to the source:

| Pattern detected | `method` value |
|------------------|---------------|
| `Authorization: Basic …` | `basic_auth` |
| `Authorization: Bearer …` | `bearer_token` |
| `Authorization: NTLM …` | `ntlm` |
| `Authorization: Negotiate …` | `negotiate` |
| Session/auth cookies | `session_cookie` |
| `X-API-Key` / `API-Key` header | `api_key` |
| Body contains password/passwd/credential fields | `form_login` |

All auto-detected credentials carry `mitre_ttp: "T1078"`.

### `http_navigation` events

Written every 3 s by the CDP monitor when a page URL changes in the built-in
browser. `chrome://`, `about:`, `devtools:`, `view-source:` filtered out.

| Key | Meaning |
|-----|---------|
| `subtype` | `navigation` |
| `url`, `prev_url`, `host`, `title`, `tab_id` | the new location and its predecessor |
| `mitre_ttp` | `T1071.001` (application-layer, web) |

### `clipboard` events (opt-in)

Off by default. When enabled in Settings ▸ Clipboard, RedLog polls (default
1500 ms), hashes with SHA-256, dedupes by hash, and runs the loot detector.
Credentials found in the content emit their own `loot` event; the clipboard
event itself records only:

| Key | Meaning |
|-----|---------|
| `subtype` | `clipboard_changed` |
| `sha256` | SHA-256 of raw text (proves "this content was seen") |
| `length`, `lines` | shape metrics |
| `lootTypes` | credential types found (`aws_key`, `jwt`, …) — never the values |
| `preview` | first 120 chars, run through redaction — **null** unless `storePreview` is on |

### `system.opsec_state_changed` events

One event per polling cycle (30 s) with a delta of what changed. Delta keys:
`vpn` (VPN-shaped interfaces up/down), `primaryMac` (randomization signal),
`dns` (resolver list), `hostname`. Detected via Node's `os.networkInterfaces()`
plus `scutil --dns` / `/etc/resolv.conf` / `Get-DnsClientServerAddress`.

### `system.config_changed` events

Emitted on every `config:save` where a security-relevant field changed. Diffed
fields: scope warnOnViolation/targets/excludeTargets/scopeFile, network white/blacklist,
engagement id, operator id/name, deconfliction endpoint. Cosmetic changes stay silent.

| Key | Meaning |
|-----|---------|
| `subtype` | `config_changed` |
| `changed` | `{ "scope.warnOnViolation": { "from": true, "to": false }, ... }` |
| `description` | comma-joined list of changed paths |

## Examples

DNS enumeration:
```json
{
  "agent_type": "dns",
  "target_id": "example.com",
  "data": {
    "subtype": "dns_query",
    "command": "dig +short api.example.com A @8.8.8.8",
    "dest_host": "api.example.com",
    "tool": "dig",
    "mitre_ttp": "T1596.001",
    "description": "Recon: enumerate A records for target apex"
  }
}
```

Credential use:
```json
{
  "agent_type": "credential_use",
  "target_id": "vpn.corp.example.com",
  "data": {
    "subtype": "successful_login",
    "user_context": "svc-backup",
    "tool": "openvpn",
    "dest_host": "vpn.corp.example.com",
    "dest_port": 1194,
    "mitre_ttp": "T1078",
    "description": "Reused leaked svc-backup credentials to establish VPN tunnel",
    "severity": "high"
  }
}
```

File transfer:
```json
{
  "agent_type": "file_transfer",
  "target_id": "10.0.0.15",
  "data": {
    "subtype": "upload",
    "command": "scp /tmp/enum.sh user@10.0.0.15:/tmp/",
    "sha256": "9f2c…",
    "bytes": 4321,
    "tool": "scp",
    "user_context": "user",
    "dest_ip": "10.0.0.15",
    "mitre_ttp": "T1105"
  }
}
```

C2 check-in:
```json
{
  "agent_type": "c2_checkin",
  "target_id": "10.0.0.15",
  "data": {
    "subtype": "beacon",
    "dest_ip": "10.0.0.15",
    "user_context": "SYSTEM",
    "mitre_ttp": "T1071.001",
    "description": "Sliver implant checked in over HTTPS after reboot",
    "bytes": 812
  }
}
```

## Why these keys

Ghostwriter's Oplog CSV import maps directly onto these fields. Populating them now means an engagement can be dumped from RedLog and imported into Ghostwriter with zero manual munging, and the client's final report can filter/pivot by MITRE technique out of the box.

## Related

- [Agent integration](agent-integration.md) — how to actually POST an event
- [Skill: redlog-pentest](skills/redlog-pentest.md) — flow that uses these keys
