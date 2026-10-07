# Quickstart: validating Terminal Auto-Capture

Two levels. The automated suite is what CI can run; the Kali walk-through is
what actually proves the feature, because the hazards this spec is built around
(job control, pagers, reverse shells) do not exist in a mocked shell.

## Prerequisites

- A Kali VM with zsh (default since 2020), `curl`, Python 3, and for the PTY
  class, `script(1)`.
- RedLog running on that machine with a project open.
- For the reverse-shell check: `nc`, `socat`.

## 1. Automated — pure units (any platform)

```bash
npx vitest run test/terminal-enrollment.test.ts test/command-class.test.ts
```

Covers the state machine (mode, durable stop, identity pinning) and the
classifier (`sudo`/`env`/`proxychains` prefixes, REPL argv forms). No shell
involved, so these run on the Windows dev box too.

## 2. Automated — the adapter, on a real interactive zsh (Linux)

```bash
npx vitest run test/zsh-auto-capture.pty.test.ts
```

**This suite must drive a real interactive zsh through a pty.** The hooks do
not fire under `zsh -c`, and a piped stdout hides the behaviour most worth
testing — which is why `tlogger-v2` drives a pty for all 73 of its checks. The
file carries `test.skip(process.platform === 'win32', …)` the way this repo's
other POSIX-fixture specs do.

What it must cover, each starting from a failing test (Principle VIII):

| Check | Proves |
|---|---|
| command + output + exit code land with nothing typed | FR-001 |
| output arrives as chunks correlated by id, with no marker in the stream | FR-002 |
| a 1 MB burst is truncated, and says so | FR-004 |
| `cmd > out.txt` records `output_disposition: redirected` | FR-008 |
| a background writer's bytes are not attributed to the foreground command | FR-007 |
| `redlog stop`, then a command, then the next prompt — still stopped | FR-022 |
| kill RedLog mid-session: commands still run, one message, spool fills | FR-009 |
| two terminals at once do not interleave | data-model |
| `stty -g` is identical before and after a paged command | research O1 |

## 3. By hand on Kali — the ones a harness cannot honestly claim

```bash
# a) enrol
#    RedLog ▸ Capture Health ▸ terminal row ▸ install. Approve once.
#    Open a NEW terminal.

redlog status          # recording, auto, project <name>

# b) the ordinary case
whoami
nmap -sV 127.0.0.1
#    → both in the timeline with output, exit code, cwd, duration.
#    → nothing was typed before the command.

# c) the line this feature must not cross
nc -lvnp 4444          # in another terminal: connect back
# Ctrl-Z
stty raw -echo; fg
#    → the upgrade works exactly as it does without RedLog installed.
#    → the timeline shows the command, and says the session body was NOT
#      captured (class: native). It does not show a silent command.

# d) the captured interactive case
socat file:`tty`,raw,echo=0 tcp-listen:4445
#    → session recorded (class: pty), and Ctrl-Z is known to be unavailable
#      for it — that is the documented trade, not a bug.

# e) stop means stop
redlog stop
whoami                 # not recorded
redlog status          # stopped
redlog start

# f) project switch
#    Switch project in RedLog while this terminal is open.
whoami
#    → NOT recorded into the new project. The terminal says it stopped and why.

# g) uninstall
#    RedLog ▸ Settings ▸ Hooks ▸ remove. Then:
diff <(git show HEAD:/dev/null) /dev/null   # placeholder: compare .zshrc
#    → the .zshrc is byte-identical to before the install, apart from nothing.
```

## 4. What "done" looks like

- SC-001: a stopwatch from "not recorded" to a verified recorded command, under
  5 minutes, one install action.
- SC-002/SC-003: a scripted engagement of ≥100 commands, every one recorded,
  none prefixed.
- SC-004: step (c) above completes with the same keystrokes as without RedLog.
- SC-005: step (f) and the kill-RedLog check, each noticed within one command.
- SC-006: a reviewer reading the timeline can tell silent from redirected from
  truncated from native, without leaving the event.

A run that cannot do step (c) on real Kali is not a verified feature, whatever
the unit suite says.
