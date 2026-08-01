# OpenCode ▸ RedLog capture plugin

Captures every OpenCode tool call into the RedLog chain via OpenCode's native
plugin API (`tool.execute.after`). Written as a single-file ES module so
operators can drop it in without a TypeScript build.

## Compared to the shell hooks

- **Codex hook** uses stdin JSON to a shell script. Verified against
  `learn.chatgpt.com/docs/hooks` (2026-08).
- **Claude Code hook** uses stdin JSON to a shell script.
- **OpenCode plugin** is a JS module that OpenCode's plugin loader auto-imports
  from `.opencode/plugins/` or `~/.config/opencode/plugins/`. The `Plugin`
  export shape + the `tool.execute.after` hook are documented at
  <https://opencode.ai/docs/plugins/>.

Every after-hook posts a `redlog agent` event with `subtype: opencode_tool`
carrying the tool name, input args, a 500-char redacted output preview, the
OpenCode session id, and the working dir.

## Install

**Project-scoped** (only this repo's OpenCode sessions get logged):
```bash
mkdir -p .opencode/plugins
ln -sf "$PWD/examples/plugins/opencode-hook/plugin/redlog.mjs" .opencode/plugins/redlog.mjs
```

**Global** (every OpenCode session on this machine gets logged):
```bash
mkdir -p ~/.config/opencode/plugins
cp examples/plugins/opencode-hook/plugin/redlog.mjs ~/.config/opencode/plugins/redlog.mjs
```

## Smoke-test

With RedLog running (any project open — the shared API server needs to be
live so `~/.redlog/api-token` and `~/.redlog/api-port` exist):

```bash
opencode run "list files in /tmp"
```

Open the RedLog Timeline. Under the Agent lane you should see events with
`subtype: opencode_tool` for each tool OpenCode ran to answer the question
(read, glob, bash, etc.).

## Privacy gates

Same two gates as every other RedLog capture hook:

1. **Recording gate** — silently skips when RedLog is paused (check
   Settings ▸ HUD or the tray icon).
2. **cwd exclusion** — reads `~/.redlog/hook-config.json`'s `excludedPaths`
   and skips when OpenCode's current `directory` matches any of them.
   Manage the list from Settings ▸ 整合 ▸ Claude Code hook 例外清單.

## What doesn't get captured

- **Streaming assistant tokens.** OpenCode fires `tool.execute.after` per
  tool call, not per assistant chunk. That's usually what you want — the
  message body is Anthropic-owned; capturing tool actions (bash, edit,
  read) is the audit-worthy signal.
- **The `input` schema is not frozen upstream.** The plugin defensively
  falls back through `output.args → output.input`. If OpenCode reshapes
  the payload the plugin still lands *some* event with the tool name;
  richer input capture may need a bump.

## Uninstall

```bash
rm ~/.config/opencode/plugins/redlog.mjs
# or, for project-scoped:
rm .opencode/plugins/redlog.mjs
```
