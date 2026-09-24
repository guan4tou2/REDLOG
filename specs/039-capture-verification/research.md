# Research: Capture Verification Contract

- HTTP events reach the renderer via `events:new-batch` as `agentType:
  'scanner'` with `http_request_start` / `http_response`
  (`HttpHistoryPanel.tsx` already filters on these).
- `redlog-session` is defined in `hooks/shell-common.sh`, shipped with the
  zsh/bash adapters (and WSL through them); the PowerShell adapter has none.
- A request through Burp alone does not reach RedLog; the waiting copy names
  the proxied browser RedLog launches.
