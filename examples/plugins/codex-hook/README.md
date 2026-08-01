# codex-hook

Tier A capture plugin for the OpenAI Codex CLI. Subscribes to Codex's native
hook API and mirrors every tool invocation to RedLog's timeline as an `agent`
event with `subtype: "codex_tool"`.

## What it captures

For each Codex tool call:
- `tool` — name of the tool Codex invoked
- `command` — the command / input line (best-effort from `tool_input`)
- `output_preview` — first N chars of `tool_response`, redacted for secrets
- `session_id` — Codex session id, when present
- `cwd` — working directory of the Codex process
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
   `hooks/codex-hook.sh` into `~/.config/codex/config.toml`'s `[hooks]` block.

## Verify

- Run any Codex tool call: `codex run 'print hello'`.
- Open **Settings ▸ Events** in RedLog and filter for `agent_type = agent` /
  `subtype = codex_tool`. A new row should appear within a second.
- If nothing shows: run the hook manually with a synthetic payload —
  ```bash
  echo '{"tool_name":"shell","tool_input":{"command":"echo hi"},"tool_response":{"output":"hi"},"session_id":"test"}' \
    | bash hooks/codex-hook.sh
  ```
  then check the RedLog log. 99% of failures are (a) `~/.redlog/api-token`
  missing (RedLog not running), (b) the recording toggle is off, or
  (c) the cwd matches an `excludedPaths` entry.

## TODO / verification note

The Codex hook config shape (`[hooks]` block keys, event names) is written
against the shape documented at <https://developers.openai.com/codex/hooks/>.
The exact TOML keys and stdin payload field names should be confirmed against
the current Codex docs — the stdin JSON parser in `codex-hook.sh` is written
defensively and accepts several plausible shapes, but tighten it once the
schema is verified.

## Trust tier

🟢 **Declarative.** No code files under `contributes.mcpTools|exporters|monitors`
— the plugin ships only a `capture` entry and a hook script the operator runs
out-of-process. Nothing to consent to; loads automatically.
