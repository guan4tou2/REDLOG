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

Existing:
- `shell` — commands captured via hooks or terminal pane
- `agent` — Claude Code / Codex tool calls
- `scanner` — mitmproxy / port scan / vuln scan output
- `screenshot` — desktop captures
- `marker` — human/agent-created finding markers
- `loot` — credential/secret detections
- `system` — RedLog itself (session start, API start, scope violations)
- `file_transfer` — file movements

Recommended additions (Timeline recognises these as first-class lanes):
- `dns` — DNS resolutions and probes (with `subtype: dns_query` / `dns_response`)
- `credential_use` — every attempted / successful credential use
- `c2_checkin` — C2 beacon / callback

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
