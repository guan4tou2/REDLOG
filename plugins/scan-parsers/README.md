# scan-parsers

Bundled RedLog pack (SPEC-AI-ERA-PLUGINS Gap 1). Turns structured scanner output
into typed `scanner.scan_result` timeline events, so a scan is more than a raw
stdout blob — each host/port (nmap) or finding (nuclei) becomes a citable event
grouped under its target.

**Trust:** 🟢 declarative. The parser runs in *your* shell as a pipe stage and
POSTs to RedLog's local authenticated API — no third-party code runs inside
RedLog, nothing can touch the hash chain. Records only while RedLog is open.

## Use

```sh
# nmap: the wrapper echoes nmap's output and captures each host
plugins/scan-parsers/hooks/nmap-redlog.sh -sV 10.0.0.0/24

# nuclei: same idea, one scan_result per finding (severity as nuclei reported it)
plugins/scan-parsers/hooks/nuclei-redlog.sh -u https://target.example.com

# or parse an existing file
cat scan.gnmap | node plugins/scan-parsers/scan-to-redlog.js nmap
cat out.jsonl  | node plugins/scan-parsers/scan-to-redlog.js nuclei
```

`nmap` must be run with greppable output (`-oG -`, the wrappers add it); `nuclei`
with `-jsonl`. Both are transparent filters — you still see the tool's output.

## What it records

- `agent_type: scanner`, `subtype: scan_result`, `target_id: <host>`
- nmap: `host`, `hostname`, `ports[]` (open only), `open_port_count`, `summary`
- nuclei: `template_id`, `name`, `severity` (verbatim from the tool), `matched_at`

Severity is recorded as the tool reported it — a fact about the tool output, not
a RedLog verdict (DESIGN-PRINCIPLES §3).

## Non-goals

Doesn't parse the raw scan file into the chain — only the normalized events land
there. Point it at the structured stream; keep your `-oN`/`-oX` files as usual.
