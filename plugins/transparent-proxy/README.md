# transparent-proxy

Captures HTTP/S from tools that **don't honour `HTTP_PROXY`** — without
configuring each tool. It redirects this host's outbound 80/443 into
mitmproxy's *transparent* mode at the OS level (iptables on Linux, pf on
macOS), then runs RedLog's existing `mitmproxy-addon.py`. The captured
request/response events are identical to the regular-proxy producer's — this
just reaches them transparently.

## Why out-of-process and privileged

Setting up a transparent redirect rewrites the host's nat rules and needs root.
RedLog doesn't hold that privilege and runs no interception code itself, so this
ships as a hook you run yourself, elevated — like the pcap producer and the
shell hooks.

## Run it

```bash
# start (rewrites THIS host's nat rules; needs root)
sudo ./hooks/transparent-proxy.sh up 8080

# stop and remove the rules (also happens automatically on Ctrl-C)
sudo ./hooks/transparent-proxy.sh down 8080
```

It installs a `trap` so the rules are torn down on Ctrl-C / exit. If the process
is killed hard, run `down` to clean up.

## Honest scope + gaps

- **Invasive.** It redirects *all* of this host's outbound 80/443 while running.
  That's the point (tools that ignore proxies get caught), but it means every
  HTTPS client on the box goes through mitmproxy and will see mitmproxy's CA —
  install/trust it for the clients you care about, and tear down when done.
- **Regular proxy is simpler** when your tool honours `HTTP_PROXY`; prefer the
  plain mitmproxy producer there. Transparent mode is for the tools that don't.
- **macOS pf** rules vary by OS version and can be constrained by SIP; if the
  `up` step fails, follow mitmproxy's current transparent-mode recipe for your
  macOS and adjust the hook.
- **Windows** isn't covered by the automatic redirect — use mitmproxy's
  WireGuard/WinDivert transparent modes instead.
- Attribution (which command opened the request) still comes from RedLog's
  ingest via `source_addr` → pid → command, same as the regular proxy path.
