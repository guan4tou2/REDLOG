# codex-hook

Tier A capture plugin for the OpenAI Codex CLI. Subscribes to Codex's native
`PostToolUse` hook and mirrors every tool invocation to RedLog's timeline as
an `agent` event with `subtype: "codex_tool"`.

## What it captures

For each Codex tool call:
- `tool` — name of the tool Codex invoked (from `tool_name`)
- `command` — the command / input line (best-effort from `tool_input.command`)
- `output_preview` — first N chars of `tool_response`, redacted for secrets
- `session_id` — Codex session id (from `session_id`)
- `cwd` — working directory of the Codex process (from `cwd`)
- `hook_event` — the Codex event that fired (defaults `PostToolUse`)
- `wrapper: "codex-hook"` — attribution

Records only while (1) RedLog is open **and** actively recording, and (2) the
Codex `cwd` is **not** in your `~/.redlog/hook-config.json` `excludedPaths`
list. Same two-gate privacy contract as `hooks/claude-code-hook.sh`.

## Install

1. Copy the plugin dir into place:
   ```bash
   cp -r examples/plugins/codex-hook ~/.redlog/plugins/
   ```
2. Restart RedLog (or click **Reload** in **Settings ▸ Plugins**). The plugin
   should appear as 🟢 declarative and the capture entry should show under
   **Settings ▸ Hooks** as "Codex (native hook)".
3. Follow the manual steps from **Settings ▸ Hooks** — they wire the bundled
   `hooks/codex-hook.sh` into `~/.codex/config.toml` as a `PostToolUse` hook.

## Config reference

Codex reads hooks from (in precedence order):
- `~/.codex/hooks.json` or the `[hooks]` block of `~/.codex/config.toml`
- `<repo>/.codex/hooks.json` or `[hooks]` in `<repo>/.codex/config.toml`
- Plugin-bundled hooks (`hooks/hooks.json` in a Codex plugin)

The TOML shape this plugin registers:
```toml
[[hooks.PostToolUse]]
matcher = ".*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "/absolute/path/to/codex-hook.sh"
timeout = 5
```

Stdin payload Codex sends to the script (PostToolUse):
```json
{
  "session_id": "…",
  "cwd": "…",
  "hook_event_name": "PostToolUse",
  "tool_name": "…",
  "tool_input": { … },
  "tool_response": { … }
}
```

Exit code convention: `0` = success, `2` = block the tool call. This script
always exits `0` — a failed capture must never block the agent.

Reference: <https://learn.chatgpt.com/docs/hooks> (verified 2026-08). The old
`developers.openai.com/codex/hooks/` URL now 308-redirects here.

## Verify

- Run any Codex tool call: `codex exec 'run echo hello'`.
- Open **Settings ▸ Events** in RedLog and filter for `agent_type = agent` /
  `subtype = codex_tool`. A new row should appear within a second.
- If nothing shows: run the hook manually with a synthetic payload —
  ```bash
  echo '{"hook_event_name":"PostToolUse","session_id":"test","cwd":"'"$PWD"'","tool_name":"shell","tool_input":{"command":"echo hi"},"tool_response":{"output":"hi"}}' \
    | bash hooks/codex-hook.sh
  ```
  then check the RedLog log. 99% of failures are (a) `~/.redlog/api-token`
  missing (RedLog not running), (b) the recording toggle is off, or
  (c) the cwd matches an `excludedPaths` entry.

## Trust tier

🟢 **Declarative.** No code files under `contributes.mcpTools|exporters|monitors`
— the plugin ships only a `capture` entry and a hook script the operator runs
out-of-process. Nothing to consent to; loads automatically.
