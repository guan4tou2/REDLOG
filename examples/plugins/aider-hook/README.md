# aider-hook

Tier B capture plugin for [Aider](https://aider.chat). Aider doesn't expose a
native hook API, but it does let you override the shell it uses to run tool
commands via `AIDER_SHELL_CMD` — this plugin points that override at a wrapper
script that brackets each command with `command_start` / `command_end` events
on RedLog's timeline before handing execution off to the real shell.

## What it captures

For each shell command Aider runs:
- `command_start` event — full command string, cwd, pid, `source: "aider-wrapper"`
- `command_end` event — same fields plus `exit_code` and `duration_sec`

Both are emitted as `agent_type: "agent"` with `subtype: "command_start" /
"command_end"` and `wrapper: "aider-wrapper"`, so they group cleanly under an
"Aider" filter alongside the built-in shell events.

Same two-gate privacy contract as `hooks/claude-code-hook.sh`: records only if
(1) RedLog is actively recording and (2) the cwd is not in `~/.redlog/hook-config.json`
`excludedPaths`.

## Install

1. Copy the plugin dir into place:
   ```bash
   cp -r examples/plugins/aider-hook ~/.redlog/plugins/
   ```
2. Restart RedLog (or click **Reload** in **Settings ▸ Plugins**). The plugin
   should appear as 🟢 declarative and the capture entry should show under
   **Settings ▸ Hooks** as "Aider (SHELL wrapper)".
3. Follow the manual steps from **Settings ▸ Hooks** — they export
   `AIDER_SHELL_CMD` in your shell rc pointing at the bundled
   `hooks/aider-wrapper.sh`, then reload your shell.

## Verify

Smoke-test the wrapper directly:
```bash
AIDER_SHELL_CMD=./hooks/aider-wrapper.sh ./hooks/aider-wrapper.sh -c 'echo hello'
```
You should see `hello` in the terminal AND a `command_start` + `command_end`
pair in **RedLog ▸ Settings ▸ Events** tagged `wrapper: "aider-wrapper"`.

Then launch Aider normally:
```bash
aider
> /run ls
```
The `ls` invocation should land as a wrapped event pair.

## TODO / verification note

The env var name and argv shape Aider uses for the shell override
(`AIDER_SHELL_CMD` invoked as `$AIDER_SHELL_CMD -c '<command>'`) is written
against the shape documented at
<https://aider.chat/docs/config/options.html#--shell>. The wrapper accepts
both `-c <string>` and bare-argv invocation forms, so most plausible shapes
work, but the env-var name should be confirmed against the current Aider docs
before relying on this in a real engagement.

If Aider uses a different env-var name in your version, just adjust the export
in your shell rc — the wrapper itself doesn't care what invoked it.

## Trust tier

🟢 **Declarative.** No `contributes.mcpTools|exporters|monitors` — the plugin
ships only a capture entry and a hook script the operator runs out-of-process.
Nothing to consent to; loads automatically.
