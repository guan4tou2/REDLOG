# Research: Managed HTTP Capture

- **Decision**: manage the installed `mitmdump` executable rather than bundle
  Python/mitmproxy or implement a proxy. This removes the operational extra
  step while preserving the proven capture path and keeping package size and
  CA behavior explicit.
- **Decision**: only loopback proxies are eligible for automatic management.
  A custom proxy may be Burp, a team relay, or another operator-owned service;
  REDLOG must not claim ownership or replace it.
- **Decision**: inject proxy variables only into new REDLOG terminal panes.
  Existing processes cannot be safely mutated and must not be described as
  routed retroactively.
- **Decision**: regular explicit proxying is the default. Privileged transparent
  interception remains a separate opt-in plugin because it changes host
  networking and has wider blast radius.

