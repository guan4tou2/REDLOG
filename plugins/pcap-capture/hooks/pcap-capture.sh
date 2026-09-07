#!/usr/bin/env bash
# pcap-capture: make the packets connection-monitor can't see (nmap -sS SYN
# scans, masscan, UDP scans) visible on the RedLog timeline. Shells out to
# tcpdump — so it needs root / CAP_NET_RAW, which RedLog itself deliberately
# does not hold. Run it yourself, elevated:
#
#   sudo "$0" <interface>            # e.g. sudo ./pcap-capture.sh eth0
#
# It captures on <interface>, folds packets into flow summaries, and POSTs them
# to RedLog's local API. Ctrl-C to stop. Nothing is captured while RedLog is
# closed (the events would have nowhere to attribute).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# Raw mode: --pcap-out <dir> <iface> — keep rotating .pcap segments (only their
# sha256 goes on the chain). Same preflight, different reader invocation.
raw_out=""
if [ "${1:-}" = "--pcap-out" ]; then
  raw_out="${2:?--pcap-out needs a directory}"
  iface="${3:?interface required after the output dir}"
else
  iface="${1:?interface required, e.g. eth0 (see: ip -o link / ifconfig)}"
fi

# ── Honest preflight: say exactly why it can't capture, don't fail obscurely ──
if ! command -v tcpdump >/dev/null 2>&1; then
  echo "[redlog pcap-capture] tcpdump not found on PATH." >&2
  echo "  Install it (Debian/Ubuntu: apt install tcpdump; macOS: it ships built-in; RHEL: dnf install tcpdump)," >&2
  echo "  then re-run. Packet capture is unavailable until then — the timeline will still have the commands, just not their raw packets." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[redlog pcap-capture] node not found on PATH (needed to post flows to RedLog)." >&2
  exit 1
fi
# Privilege check — capture needs root or CAP_NET_RAW. A clear message beats
# tcpdump's own "you don't have permission to capture".
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v getcap >/dev/null 2>&1 || ! getcap "$(command -v tcpdump)" 2>/dev/null | grep -q cap_net_raw; then
    echo "[redlog pcap-capture] not root and tcpdump lacks cap_net_raw — packet capture needs elevation." >&2
    echo "  Re-run with sudo:  sudo \"$0\" $iface" >&2
    echo "  (Or grant the capability once:  sudo setcap cap_net_raw+ep \"\$(command -v tcpdump)\")" >&2
    exit 1
  fi
fi

# Raw mode: hand the reader the output dir + interface; no BPF filter (the raw
# .pcap is the whole point). Loopback POSTs are tiny and harmless in a raw dump.
if [ -n "$raw_out" ]; then
  echo "[redlog pcap-capture] raw capture on $iface → $raw_out (Ctrl-C to stop)…" >&2
  exec node "$here/pcap-capture.js" --pcap-out "$raw_out" "$iface"
fi

# Summary mode: don't capture our own loopback POSTs to the API (feedback loop).
api_port="$(cat "$HOME/.redlog/api-port" 2>/dev/null || echo '')"
filter=()
if [ -n "$api_port" ]; then
  filter=(not '(' host 127.0.0.1 and port "$api_port" ')')
fi

echo "[redlog pcap-capture] capturing on $iface (Ctrl-C to stop)…" >&2
exec node "$here/pcap-capture.js" "$iface" "${filter[@]}"
