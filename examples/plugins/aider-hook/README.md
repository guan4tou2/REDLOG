# aider-hook

Tier B capture plugin for [Aider](https://aider.chat). Aider doesn't expose a
native hook API — this plugin overrides `$SHELL` so Aider's pexpect (TTY)
code path routes every command it runs through a wrapper script, which
brackets each command with `command_start` / `command_end` events on
RedLog's timeline before handing execution off to a real shell.

## What it captures

For each shell command Aider runs on the pexpect (TTY) code path:
- `command_start` event — full command string, cwd, pid, `source: "aider-wrapper"`
- `command_end` event — same fields plus `exit_code` and `duration_sec`

Both are emitted as `agent_type: "agent"` with `subtype: "command_start" /
"command_end"` and `wrapper: "aider-wrapper"`, so they group cleanly under an
"Aider" filter alongside the built-in shell events.

Same two-gate privacy contract as `hooks/claude-code-hook.sh`: records only if
(1) RedLog is actively recording and (2) the cwd is not in `~/.redlog/hook-config.json`
`excludedPaths`.

## How it hooks in

Aider's `aider/run_cmd.py` has two paths:

- **pexpect (TTY, non-Windows).** Reads `os.environ["SHELL"]` (fallback
  `/bin/sh`) and calls `pexpect.spawn(shell, ["-i", "-c", command])`. This
  IS interceptable — set `SHELL` to `hooks/aider-wrapper.sh` and it gets
  invoked as `aider-wrapper.sh -i -c '<command>'` for every command.
- **subprocess (no TTY, or Windows).** Uses `subprocess.Popen(command,
  shell=True)`. On POSIX this always executes `/bin/sh -c '<command>'`
  regardless of `$SHELL`, so commands on this path CANNOT be captured this
  way. Aider on a TTY (the normal interactive case) is fine; piped/CI runs
  are not.

Verified 2026-08 against
[`aider/run_cmd.py`](https://github.com/Aider-AI/aider/blob/main/aider/run_cmd.py).
There is no `AIDER_SHELL` / `AIDER_SHELL_CMD` env var or `--shell` flag —
the underlying feature request lives in Aider issues
[#1215](https://github.com/Aider-AI/aider/issues/1215) and
[#1337](https://github.com/Aider-AI/aider/issues/1337) and is unimplemented.
If Aider ships one later, prefer it over overriding `$SHELL`.

## Install

1. Copy the plugin dir into place:
   ```bash
   cp -r examples/plugins/aider-hook ~/.redlog/plugins/
   ```
2. Restart RedLog (or click **Reload** in **Settings ▸ Plugins**). The plugin
   should appear as 🟢 declarative and the capture entry should show under
   **Settings ▸ Hooks** as "Aider (SHELL wrapper)".
3. Launch Aider with `SHELL` pointing at the bundled wrapper:
   ```bash
   SHELL="$HOME/.redlog/plugins/aider-hook/hooks/aider-wrapper.sh" aider
   ```
   Prefer scoping it per-invocation (as above) rather than exporting it
   globally — a permanently overridden `$SHELL` affects every process, not
   just Aider.

## Verify

Smoke-test the wrapper directly:
```bash
./hooks/aider-wrapper.sh -i -c 'echo hello'
```
You should see `hello` in the terminal AND a `command_start` + `command_end`
pair in **RedLog ▸ Settings ▸ Events** tagged `wrapper: "aider-wrapper"`.

Then launch Aider through it:
```bash
SHELL=./hooks/aider-wrapper.sh aider
> /run ls
```
The `ls` invocation should land as a wrapped event pair.

## Known gaps

- **Non-TTY runs (CI, `aider < prompts.txt`, Windows).** These go through
  `subprocess.Popen(shell=True)` which uses `/bin/sh` unconditionally — the
  wrapper never sees them. This is an Aider limitation, not a plugin bug.
- **`SHELL` is a very blunt lever.** Exporting `SHELL=aider-wrapper.sh` in
  your login rc affects every child of that shell, not just Aider. Prefer the
  per-invocation form (`SHELL=… aider`) unless you specifically want that.

## Trust tier

🟢 **Declarative.** No `contributes.mcpTools|exporters|monitors` — the plugin
ships only a capture entry and a hook script the operator runs out-of-process.
Nothing to consent to; loads automatically.
