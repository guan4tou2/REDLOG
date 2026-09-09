#!/usr/bin/env python3
"""RedLog pcap capture agent — an out-of-process 🟢 capture producer.

Fills the gap the app-layer proxy and the established-only connection monitor
cannot see: TCP connection *attempts* (SYN scans like `nmap -sS` complete no
handshake, so they never reach the connection monitor), refused connections,
and non-proxied UDP flow metadata. Like hooks/mitmproxy-addon.py it only POSTs
events to RedLog's authenticated local API — it never touches the DB, keys, or
chain, so a bug here can add noise but cannot forge or corrupt evidence.

It summarises, it does not dump packets: a port scan is emitted as ONE
`pcap.port_scan` event, not 65,535 rows; ordinary traffic is one
`pcap.connection_attempt` per (host, port). Payloads are never captured — HTTP
bodies belong to the mitmproxy addon, and raw payloads would bloat the store and
duplicate it.

Usage (needs root/sudo for raw capture; needs scapy):
    pip install scapy
    sudo -E python3 hooks/pcap-agent.py -i en0
    sudo -E python3 hooks/pcap-agent.py -i eth0 --filter "tcp or udp"

Verify without root or a live NIC:
    python3 hooks/pcap-agent.py --dry-run

Env: REDLOG_VERBOSE=1 logs each emitted event.
"""

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

try:
    import urllib.request
except ImportError:  # pragma: no cover
    urllib = None

REDLOG_PORT_FILE = Path.home() / ".redlog" / "api-port"
REDLOG_TOKEN_FILE = Path.home() / ".redlog" / "api-token"
SPOOL_DIR = Path.home() / ".redlog" / "pending"

VERBOSE = os.environ.get("REDLOG_VERBOSE", "false").lower() in ("true", "1", "yes")

# A dst_ip that draws SYNs to at least this many distinct ports within one
# flush window is reported as a single port_scan, not one row per port.
SCAN_PORT_THRESHOLD = int(os.environ.get("REDLOG_PCAP_SCAN_PORTS", "15"))
# How often the aggregator flushes its per-host SYN buffers, in seconds.
FLUSH_INTERVAL = float(os.environ.get("REDLOG_PCAP_FLUSH_SEC", "3"))


# ─── RedLog API (mirrors hooks/mitmproxy-addon.py) ──────────────────────────

def _get_redlog_connection():
    if not REDLOG_PORT_FILE.exists() or not REDLOG_TOKEN_FILE.exists():
        return None, None
    return REDLOG_PORT_FILE.read_text().strip(), REDLOG_TOKEN_FILE.read_text().strip()


def _spool_payload(payload: dict) -> None:
    try:
        SPOOL_DIR.mkdir(parents=True, exist_ok=True)
        (SPOOL_DIR / f"{int(time.time() * 1000)}-{id(payload)}.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )
    except Exception:
        pass


def _send_to_redlog(payload: dict) -> None:
    port, token = _get_redlog_connection()
    if not port:
        if VERBOSE:
            print("[redlog-pcap] no api-port/token — is RedLog running with a project open?", file=sys.stderr)
        return

    def _do_send():
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/events",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            _spool_payload(payload)

    threading.Thread(target=_do_send, daemon=True).start()


def _emit(subtype: str, dst_ip: str, data: dict) -> None:
    """POST one pcap event. target_id = dst_ip so scope classification and the
    Targets aggregate treat a sniffed host like any other target."""
    payload = {"agent_type": "pcap", "target_id": dst_ip, "data": {"subtype": subtype, **data}}
    _send_to_redlog(payload)
    if VERBOSE:
        print(f"[redlog-pcap] {subtype} {dst_ip} {json.dumps(data)}", file=sys.stderr)


# ─── SYN aggregation ────────────────────────────────────────────────────────

class SynAggregator:
    """Buffers TCP SYN probes per destination host and, on flush, emits either
    individual connection_attempt events (a handful of ports) or one port_scan
    (many ports) — so a full-range scan is a summary, not a flood."""

    def __init__(self, emit=_emit):
        self._emit = emit
        self._lock = threading.Lock()
        # dst_ip -> { port -> first_ts_ms }
        self._buf: dict[str, dict[int, int]] = {}
        self._stop = threading.Event()

    def add_syn(self, dst_ip: str, dst_port: int, ts_ms: int) -> None:
        with self._lock:
            self._buf.setdefault(dst_ip, {}).setdefault(dst_port, ts_ms)

    def flush(self) -> None:
        with self._lock:
            buf, self._buf = self._buf, {}
        for dst_ip, ports in buf.items():
            if len(ports) >= SCAN_PORT_THRESHOLD:
                sorted_ports = sorted(ports)
                self._emit("port_scan", dst_ip, {
                    "port_count": len(ports),
                    "port_min": sorted_ports[0],
                    "port_max": sorted_ports[-1],
                    "ports_sample": sorted_ports[:50],
                    "first_at": min(ports.values()),
                    "last_at": max(ports.values()),
                    "proto": "tcp",
                })
            else:
                for port, ts in sorted(ports.items()):
                    self._emit("connection_attempt", dst_ip, {
                        "dst_port": port, "proto": "tcp", "at": ts,
                    })

    def run_flusher(self) -> None:
        while not self._stop.wait(FLUSH_INTERVAL):
            try:
                self.flush()
            except Exception:
                pass

    def stop(self) -> None:
        self._stop.set()
        self.flush()


# ─── Live capture (scapy) ───────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)


def run_capture(iface: str | None, bpf: str) -> int:
    try:
        from scapy.all import sniff, IP, IPv6, TCP, UDP  # type: ignore
    except ImportError:
        print("[redlog-pcap] scapy not installed. Run: pip install scapy", file=sys.stderr)
        return 2

    # Don't capture our own POSTs to the RedLog API.
    api_port, _ = _get_redlog_connection()
    udp_seen: set[tuple[str, int]] = set()
    agg = SynAggregator()
    threading.Thread(target=agg.run_flusher, daemon=True).start()

    def handle(pkt) -> None:
        ip = pkt.getlayer(IP) or pkt.getlayer(IPv6)
        if ip is None:
            return
        dst_ip = ip.dst
        ts = _now_ms()
        if pkt.haslayer(TCP):
            tcp = pkt.getlayer(TCP)
            if api_port and int(tcp.dport) == int(api_port) and dst_ip in ("127.0.0.1", "::1"):
                return
            flags = int(tcp.flags)
            syn, ack, rst = bool(flags & 0x02), bool(flags & 0x10), bool(flags & 0x04)
            if syn and not ack:
                agg.add_syn(dst_ip, int(tcp.dport), ts)
            elif syn and ack:
                _emit("connection_established", ip.src, {"dst_port": int(tcp.sport), "proto": "tcp", "at": ts})
            elif rst and not syn:
                _emit("connection_refused", ip.src, {"dst_port": int(tcp.sport), "proto": "tcp", "at": ts})
        elif pkt.haslayer(UDP):
            udp = pkt.getlayer(UDP)
            key = (dst_ip, int(udp.dport))
            if key in udp_seen:
                return
            udp_seen.add(key)
            _emit("udp_flow", dst_ip, {"dst_port": int(udp.dport), "proto": "udp", "at": ts})

    print(f"[redlog-pcap] capturing on {iface or 'default'} (filter: {bpf}) — Ctrl-C to stop", file=sys.stderr)
    try:
        sniff(iface=iface, filter=bpf, prn=handle, store=False)
    except KeyboardInterrupt:
        pass
    except PermissionError:
        print("[redlog-pcap] permission denied — raw capture needs root (sudo).", file=sys.stderr)
        return 2
    finally:
        agg.stop()
    return 0


# ─── Dry run (no root, no NIC — proves the event shapes) ────────────────────

def run_dry() -> int:
    emitted: list[tuple[str, str, dict]] = []
    agg = SynAggregator(emit=lambda st, ip, d: emitted.append((st, ip, d)))
    # 3 ports to one host → individual attempts; 20 ports to another → port_scan.
    for p in (22, 80, 443):
        agg.add_syn("10.10.11.24", p, _now_ms())
    for p in range(1, 21):
        agg.add_syn("10.10.11.7", p, _now_ms())
    agg.flush()
    agg._emit("connection_established", "10.10.11.24", {"dst_port": 22, "proto": "tcp", "at": _now_ms()})
    agg._emit("udp_flow", "10.10.11.53", {"dst_port": 53, "proto": "udp", "at": _now_ms()})
    subtypes = sorted({st for st, _, _ in emitted})
    print(json.dumps({"emitted": len(emitted), "subtypes": subtypes,
                      "events": [{"subtype": st, "target": ip, **d} for st, ip, d in emitted]}, indent=2))
    assert "port_scan" in subtypes and "connection_attempt" in subtypes, "aggregation broken"
    # 3 attempts + 1 port_scan + 1 established + 1 udp_flow = 6
    assert len(emitted) == 6, f"expected 6 events, got {len(emitted)}"
    print("[redlog-pcap] dry-run OK", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="RedLog pcap capture agent")
    ap.add_argument("-i", "--iface", default=None, help="interface (default: scapy's default)")
    ap.add_argument("--filter", default="tcp or udp", help="BPF filter (default: 'tcp or udp')")
    ap.add_argument("--dry-run", action="store_true", help="emit synthetic events and exit (no capture)")
    args = ap.parse_args()
    return run_dry() if args.dry_run else run_capture(args.iface, args.filter)


if __name__ == "__main__":
    sys.exit(main())
