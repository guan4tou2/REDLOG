#!/usr/bin/env bash
# transparent-proxy: intercept HTTP/S from tools that DON'T honour HTTP_PROXY —
# without configuring each tool. It sets up an OS-level redirect of your own
# outbound 80/443 into mitmproxy's transparent mode, which then runs RedLog's
# existing mitmproxy addon (so the captured request/response events are
# identical to the regular-proxy path, just reached transparently).
#
# This is INVASIVE and PRIVILEGED: it rewrites your host's nat rules and needs
# root. It only redirects THIS host's outbound traffic (OUTPUT/pf on the local
# box), not a network's. Always tear down when done.
#
#   sudo "$0" up      [listen_port]   # default 8080 — install rules + run mitmdump
#   sudo "$0" down    [listen_port]   # remove the rules (also runs automatically on Ctrl-C)
#
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"          # <resources>/plugins/transparent-proxy
resources="$(cd "$here/../.." && pwd)"            # <resources>
addon="$resources/hooks/mitmproxy-addon.py"
action="${1:?up|down required}"
port="${2:-8080}"

if [ "$(id -u)" -ne 0 ]; then
  echo "[redlog transparent-proxy] needs root to change nat rules. Re-run: sudo \"$0\" $action $port" >&2
  exit 1
fi

os="$(uname -s)"

teardown() {
  case "$os" in
    Linux)
      iptables -t nat -D OUTPUT -p tcp --dport 80  -j REDIRECT --to-port "$port" 2>/dev/null || true
      iptables -t nat -D OUTPUT -p tcp --dport 443 -j REDIRECT --to-port "$port" 2>/dev/null || true
      ;;
    Darwin)
      pfctl -a redlog-transparent -F all 2>/dev/null || true
      pfctl -d 2>/dev/null || true
      ;;
  esac
  echo "[redlog transparent-proxy] redirect rules removed." >&2
}

if [ "$action" = "down" ]; then
  teardown
  exit 0
fi

# ── up ────────────────────────────────────────────────────────────────────
if ! command -v mitmdump >/dev/null 2>&1; then
  echo "[redlog transparent-proxy] mitmdump not found. Install mitmproxy (pipx install mitmproxy) and retry." >&2
  echo "  Transparent capture is unavailable until then; tools that DO honour HTTP_PROXY can still use the regular mitmproxy producer." >&2
  exit 1
fi
if [ ! -f "$addon" ]; then
  echo "[redlog transparent-proxy] RedLog mitmproxy addon not found at $addon" >&2
  exit 1
fi

case "$os" in
  Linux)
    if ! command -v iptables >/dev/null 2>&1; then
      echo "[redlog transparent-proxy] iptables not found — cannot set up the redirect on this host." >&2
      exit 1
    fi
    sysctl -w net.ipv4.ip_forward=1 >/dev/null
    iptables -t nat -A OUTPUT -p tcp --dport 80  -j REDIRECT --to-port "$port"
    iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port "$port"
    ;;
  Darwin)
    echo "rdr pass on lo0 inet proto tcp to any port {80,443} -> 127.0.0.1 port $port" \
      | pfctl -a redlog-transparent -f - 2>/dev/null || {
        echo "[redlog transparent-proxy] failed to load pf rules (macOS pf can be finicky under SIP)." >&2
        echo "  See mitmproxy's transparent-mode docs for the current pf recipe on your macOS version." >&2
        exit 1
      }
    pfctl -e 2>/dev/null || true
    ;;
  *)
    echo "[redlog transparent-proxy] unsupported OS '$os' for automatic redirect. Windows: use WinDivert/mitmproxy's wireguard mode instead." >&2
    exit 1
    ;;
esac

trap teardown EXIT INT TERM
echo "[redlog transparent-proxy] redirecting local 80/443 → mitmproxy :$port (Ctrl-C to stop and remove rules)…" >&2
exec mitmdump --mode transparent --listen-port "$port" -s "$addon"
