# Research: Capture Packs

- **Why not move the code into plugins**: plugin code runs only as an external
  script or a privileged tailer in the main process (Spec 027 removed the code
  host). Rehosting monitors and tailers as plugin code would rebuild that host
  without isolation and put plugin-shaped seams on the evidence path.
- **Why per-project pack switches plus a global plugin**: what is recorded is
  part of an engagement, so it lives in the project config; the plugin lets an
  operator remove a capability from every project, like starter-pack.
- **HTTP(S)**: the managed proxy, an operator-run mitmproxy and transparent
  mode all run `hooks/mitmproxy-addon.py` and emit identical events — one
  source, three ways in.
- **Found while checking the old behaviour**: on main, only project open
  passed `enabled` to the agent tailer; saving Settings did not, so the AI
  switch took effect only on reopen. `applyCapturePacks()` runs on save too.
