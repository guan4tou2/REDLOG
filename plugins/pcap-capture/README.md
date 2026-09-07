# pcap-capture

Makes the one class of traffic RedLog's connection monitor **structurally
cannot see** visible on the timeline: half-open probes that never complete a
handshake — `nmap -sS` SYN scans, `masscan`, UDP scans. The socket table only
lists *established* connections, so those scans otherwise leave a command on the
timeline and no packets. This closes that gap by reading raw packets with
`tcpdump`.

## Why it's a separate, out-of-process producer

Packet capture needs root / `CAP_NET_RAW`. RedLog deliberately does **not** run
with those privileges, and no capture code runs inside it. So this ships as a
producer you run yourself, elevated — exactly like the shell hooks and the
mitmproxy addon. It POSTs flow summaries to RedLog's local API; RedLog stores
and attributes them.

## Run it

```bash
# find your interface
ip -o link            # Linux
ifconfig -l           # macOS

# capture (elevated)
sudo ./hooks/pcap-capture.sh eth0
```

On **Windows** the same capture runs over npcap via `tshark` — install
Wireshark + npcap, then from an **elevated** PowerShell:

```powershell
tshark -D    # list interfaces
powershell -ExecutionPolicy Bypass -File .\hooks\pcap-capture.ps1 -Interface "Ethernet"
```

Ctrl-C to stop. It captures nothing while RedLog is closed (a flow with nowhere
to attribute is not evidence). Its own loopback POSTs to the API are excluded
from capture (Linux/macOS filter; on Windows narrow the interface instead).

## What lands on the timeline

One `scanner.packet_flow` event per flow (5-tuple), carrying:

- `src` / `src_port` / `dst` / `dst_port` / `proto` / `ip_version`
- `packets`, `bytes`, `first_ts`, `last_ts`, `tcp_flags`
- `handshake` — did the flow ever complete a TCP handshake
- **`syn_only`** — a half-open probe the connection monitor is blind to; the
  event carries a `note` saying so, so filtering to `syn_only` explains why
  these have no matching `scanner.connection`
- `local_port` — the local source port, which RedLog's ingest resolves to the
  owning command (`local_port → pid → command`), so a SYN scan links back to the
  `nmap` that produced it

## Raw packets (optional)

The default mode records flow *structure*, not every byte. For deep-packet
forensics, run with `--pcap-out <dir>` to also keep **rotating binary `.pcap`
segments** on your disk:

```bash
sudo ./hooks/pcap-capture.sh --pcap-out ~/redlog-pcap eth0
```

RedLog holds no packets — the `.pcap` files stay where you wrote them. What
reaches the timeline is a `scanner.pcap_segment` integrity record per segment:
its `pcap_file` path and `pcap_sha256`, and the **sha256 goes on the hash
chain**. So the chain proves what each `.pcap` was; you preserve the files, and
a later analyst can verify one against its recorded hash.

## Honest gaps

- **Attribution** depends on RedLog's socket→pid→command table having seen the
  command; a scan from a process RedLog never saw a `command_start` for lands as
  an unattributed flow (kept, not dropped).
- **macOS** can capture, but per-process attribution there is weaker (the socket
  table doesn't hand out pids without `lsof`/root — same limitation the
  connection monitor documents).
- Default capture is **text-mode** tcpdump, not a stored binary `.pcap` (use
  `--pcap-out` above for that). It records the flow structure RedLog reasons
  about, not every byte; deep-packet forensics wants the raw pcap alongside.
