# Contract: what the operator can type

The whole operator-facing surface. Six commands, because the point of the
feature is that there is nothing to type for the ordinary case.

| Command | Does | Notes |
|---|---|---|
| `redlog status` | whether this terminal's commands are being recorded, with mode and bound project | answers FR-023 from inside the terminal; exit 0 only while they are (see below) |
| `redlog stop` | stops recording **in this terminal**, durably | survives the next prompt even in auto mode (FR-022) |
| `redlog start` | starts recording in this terminal | in manual mode this is how a terminal opts in |
| `redlog mode auto\|manual` | switches the machine's mode | no reinstall (FR-021) |
| `redlog class list\|add\|remove <cmd>` | moves a command between handling classes | `add` to the PTY class warns that local suspension is lost (FR-028) |
| `redlog note "<text>"` | an operator note, attributed to this terminal | optional; drop if it duplicates the existing marker path |

**Namespacing**: one `redlog` function with subcommands, not six globals. The
installed block in `.zshrc` therefore defines one name, which is also what
makes uninstall verifiable (FR-016).

Loading the hook announces only that it loaded, not that output was saved.
`redlog status` asks the running RedLog (`/api/health`, then `/api/recording`)
and prints one line; the mode and project stay in every state this terminal has
them. It is the only thing that asks: nothing on the per-command path does.

| Line begins | State | Exit |
|---|---|---|
| `recording enabled` | this terminal's switch is on, RedLog has a project open and is recording | 0 |
| `recording paused` | RedLog has a project open and is paused | non-zero |
| `RedLog running, no project open` | RedLog answers `/api/health` with no project | non-zero |
| `RedLog running, recording state could not be read` | RedLog answers but the token is refused, or the answer does not say `"recording":true` or `false` | non-zero |
| `RedLog not reachable` | nothing answers on the port the files name, or there are no port/token files | non-zero |
| `this terminal is not recorded — RedLog is set to record only in …` | the machine records one terminal app and this is not it (nothing is asked of RedLog) | non-zero |

A terminal stopped with `redlog stop` keeps saying `stopped (…)`, and
missing project/operator identity is explicitly `not recording` with a
new-terminal recovery path because project binding is pinned; both exit
non-zero. `recording enabled` is never printed without RedLog having said it
is recording, and it is still not a delivery acknowledgement. The status is the
same under the caller's `set -e` / `ERR_RETURN`. Start reports the resulting state, including a refusal after a project
switch, and must not emit `capture_resumed` when the terminal stayed stopped.

**Install / uninstall** are not shell commands. They are RedLog actions:

- from the capture card's `terminal` row, which already says "your own terminal
  is not in the record" (FR-014);
- from Settings ▸ Hooks, where the existing shell hook install lives;
- uninstall from either, leaving the `.zshrc` as it was.

## Rules that bind every one of them

1. **A command here never changes what the operator's next command does.**
   `redlog stop` stops recording; it does not alter the shell's environment,
   aliases, or descriptors beyond restoring them.
2. **Status is read from the state file, not from a shell variable**, so the
   answer is the same one RedLog gives in the card.
3. **An unknown subcommand prints the list and exits non-zero**, so a typo is
   not silently a no-op.
4. **The installed block defines exactly one function name**, and uninstall
   removes exactly the block it wrote.
