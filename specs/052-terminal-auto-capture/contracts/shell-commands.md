# Contract: what the operator can type

The whole operator-facing surface. Six commands, because the point of the
feature is that there is nothing to type for the ordinary case.

| Command | Does | Notes |
|---|---|---|
| `redlog status` | live app state, terminal eligibility, mode and active project | answers FR-023 from inside the terminal |
| `redlog stop` | stops recording **in this terminal**, durably | survives the next prompt even in auto mode (FR-022) |
| `redlog start` | starts recording in this terminal | in manual mode this is how a terminal opts in |
| `redlog mode auto\|manual` | switches the machine's mode | no reinstall (FR-021) |
| `redlog class list\|add\|remove <cmd>` | moves a command between handling classes | `add` to the PTY class warns that local suspension is lost (FR-028) |
| `redlog note "<text>"` | an operator note, attributed to this terminal | optional; drop if it duplicates the existing marker path |

**Namespacing**: one `redlog` function with subcommands, not six globals. The
installed block in `.zshrc` therefore defines one name, which is also what
makes uninstall verifiable (FR-016).

The hook is silent while recording. Status checks `/api/health` and exits
non-zero if the app is unreachable, has no project open, is paused, or this
terminal cannot record into the active project. Local terminal eligibility
still comes from its pinned state file. Start reports the resulting state, including a refusal after a project
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
2. **Status combines live app health and the terminal state file**. The hook
   reports a changed delivery failure once per reason, at the prompt. If
   commands were dropped, the next successful delivery reports their count
   and time range through the existing capture gap event.
3. **An unknown subcommand prints the list and exits non-zero**, so a typo is
   not silently a no-op.
4. **The installed block defines exactly one function name**, and uninstall
   removes exactly the block it wrote.
