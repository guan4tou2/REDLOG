#!/usr/bin/env python3
"""RedLog's output relay: run a command, let its bytes through, keep a copy.

This is the body of `redlog-run` (`hooks/shell-common.sh`) lifted out of the
shell. It was a pair of named pipes, two `tee`s and an inline Python event
builder; spec 052 needs the same capture from `preexec`, for every command,
and two implementations of "record a command's output" would drift. One lives
here, both callers use it (research.md D2, Principle III).

Four modes, two callers:

    redlog-relay.py run --event-out PATH [--max-bytes N] [--cwd DIR]
                        [--captured-by NAME] [--command-id ID]
                        -- COMMAND [ARG...]

        `redlog-run`: launch the command, relay its output, write the event.

    redlog-relay.py classify -- COMMAND [ARG...]        -> relayed|pty|native
    redlog-relay.py pipe --event-out PATH --stream stdout [--max-bytes N]
    redlog-relay.py finish --stdout-part A --stderr-part B [...]   -> JSON

        The zsh adapter: it diverts the SHELL's descriptors in `preexec` and
        restores them in `precmd`, so the command itself is never launched by
        anything here and keeps its terminal, stdin and job control.

The event is written to `--event-out` as JSON, never to stdout: stdout belongs
to the command. `<event-out>.started` is created the moment the command is
launched, and is how the caller knows not to run the command a second time —
the difference between "the relay could not start" and "the command failed".

Exit status is the command's own, by the shell's conventions: 127 not found,
126 not executable, 128+N killed by signal N. A caller that reported the
relay's status instead would make every recorded failure a lie.

Standard library only, and no third-party anything: this runs on the
operator's machine, inside their shell, on every command.
"""
import json
import os
import re
import select
import subprocess
import sys
import time

DEFAULT_MAX_BYTES = 102400  # 100 KB per stream, as redlog-run has always used

# `env FOO=bar cmd` — the assignments belong to the wrapper, not the command.
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


class Stream:
    """One descriptor: everything through to the terminal, the first CAP bytes
    kept, and a count of what really passed.

    The count is of all of it. A record that says 64 bytes when 200 went by is
    worse than one that says nothing, because the operator believes it.
    """

    def __init__(self, source, sink, cap):
        self.source = source
        self.sink = sink
        self.cap = cap
        self.kept = bytearray()
        self.total = 0

    def pump(self):
        chunk = os.read(self.source.fileno(), 65536)
        if not chunk:
            return False
        if self.sink is not None:
            try:
                self.sink.write(chunk)
                self.sink.flush()  # the operator watches a scan run, not a replay
            except (BrokenPipeError, ValueError, OSError):
                # `redlog-run nmap … | head -1` closes the far end. A plain
                # tool would die here; the relay stops writing and keeps
                # draining, so the command is not blocked and the event is
                # still written. The record outlives the pipe.
                self.sink = None
        self.total += len(chunk)
        room = self.cap - len(self.kept)
        if room > 0:
            self.kept.extend(chunk[:room])
        return True

    def text(self):
        # Invalid UTF-8 becomes U+FFFD rather than an exception. The command
        # whose output is not text is exactly the one worth having recorded.
        return self.kept.decode("utf-8", errors="replace")

    def truncated(self):
        return self.total > self.cap


def run(argv):
    opts, command = parse(argv)
    normalise(opts)
    if not command:
        sys.stderr.write("redlog-relay: expected a command\n")
        return 2

    cap = opts["max_bytes"]
    started_at = time.time()
    # Before the attempt, not after it. The marker says "the relay has taken
    # this command", which is what the caller needs in order not to run it a
    # second time — including when it could not be started at all, because the
    # relay has already said so on the terminal in the shell's own words. The
    # marker's absence means the relay never got this far, and only then is
    # falling back to running the command unrecorded the right thing.
    touch(opts["event_out"] + ".started")
    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # stdin is left alone: the command keeps the terminal it was
            # given, which is what makes it still interactive.
        )
    except FileNotFoundError:
        sys.stderr.write("redlog-relay: %s: command not found\n" % command[0])
        return emit(opts, 127, started_at, None, None)
    except OSError as exc:  # not executable, a directory, ETXTBSY, ENOMEM…
        sys.stderr.write("redlog-relay: %s: %s\n" % (command[0], exc.strerror or exc))
        return emit(opts, 126, started_at, None, None)

    out = Stream(proc.stdout, sys.stdout.buffer, cap)
    err = Stream(proc.stderr, sys.stderr.buffer, cap)
    live = {proc.stdout.fileno(): out, proc.stderr.fileno(): err}
    while live:
        ready, _, _ = select.select(list(live), [], [], 0.2)
        for fd in ready:
            stream = live[fd]
            try:
                alive = stream.pump()
            except OSError:
                alive = False
            if not alive:
                del live[fd]
    code = proc.wait()
    if code < 0:  # killed by a signal; report it as the shell does
        code = 128 + (-code)
    return emit(opts, code, started_at, out, err)


def touch(path):
    try:
        with open(path, "wb"):
            pass
    except OSError:
        pass


def emit(opts, code, started_at, out, err):
    # `out`/`err` are None when the command never started. The difference
    # between "it produced nothing" and "nothing was ever held" is the whole
    # of Principle VI, so it is said in the record and not left to be
    # inferred from an empty string.
    held = out is not None or err is not None
    cut = [
        "%s:%d" % (name, stream.cap)
        for name, stream in (("stdout", out), ("stderr", err))
        if stream is not None and stream.truncated()
    ]
    if not held:
        completeness, disposition = "metadata-only", "not-captured"
    elif cut:
        completeness, disposition = "truncated", "captured"
    else:
        completeness, disposition = "complete", "captured"

    event = {
        "exit_code": code,
        "duration_sec": int(time.time() - started_at),
        "cwd": opts["cwd"],
        "stdout": out.text() if out else "",
        "stderr": err.text() if err else "",
        "stdout_bytes": out.total if out else 0,
        "stderr_bytes": err.total if err else 0,
        "stdout_truncated": bool(out and out.truncated()),
        "stderr_truncated": bool(err and err.truncated()),
        "captured_by": opts["captured_by"],
        # The correlation key the caller minted. The relay never invents one:
        # `command_start` has already gone out carrying it, and an id made
        # here would correlate with nothing.
        "command_id": opts["command_id"],
        "completeness": completeness,
        "output_disposition": disposition,
        "limit_hit": ",".join(cut) if cut else None,
    }
    # Written whole, then moved into place: a caller that reads a half-written
    # event would record a command that did not happen. If the write fails the
    # caller falls back to bare metadata, as it always has — losing the body is
    # survivable, losing the exit code is not, and the shell already holds that.
    write_json(opts["event_out"], event)
    return code


def parse(argv):
    opts = {
        "event_out": None,
        "max_bytes": DEFAULT_MAX_BYTES,
        "cwd": os.getcwd(),
        "captured_by": "redlog-relay",
        "command_id": None,
        "stream": "stdout",
        "stdout_part": None,
        "stderr_part": None,
        "exit_code": "0",
        "duration_sec": "0",
        "drain_timeout": "5",
        "source": None,
        "command_line": "",
        "field": None,
        "home": None,
        "session": None,
        "action": None,
        "engagement": None,
        "operator": None,
        "mode": None,
        "reason": "operator",
        "format": "json",
        "command": None,
    }
    flags = {
        "--event-out": "event_out",
        "--max-bytes": "max_bytes",
        "--cwd": "cwd",
        "--captured-by": "captured_by",
        "--command-id": "command_id",
        "--stream": "stream",
        "--stdout-part": "stdout_part",
        "--stderr-part": "stderr_part",
        "--exit-code": "exit_code",
        "--duration-sec": "duration_sec",
        "--drain-timeout": "drain_timeout",
        "--source": "source",
        "--command-line": "command_line",
        "--field": "field",
        "--home": "home",
        "--session": "session",
        "--action": "action",
        "--engagement": "engagement",
        "--operator": "operator",
        "--mode": "mode",
        "--reason": "reason",
        "--format": "format",
        "--command": "command",
    }
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--":
            return opts, argv[i + 1:]
        if token in flags:
            opts[flags[token]] = argv[i + 1]
            i += 2
            continue
        raise SystemExit("redlog-relay: unknown option %s" % token)
    return opts, []


def normalise(opts):
    try:
        opts["max_bytes"] = max(0, int(opts["max_bytes"]))
    except (TypeError, ValueError):
        opts["max_bytes"] = DEFAULT_MAX_BYTES
    return opts


# ── The automatic path ──────────────────────────────────────────────────────
#
# `redlog-run` hands the relay a command to launch. The zsh adapter cannot: it
# diverts the SHELL's own descriptors in `preexec` and restores them in
# `precmd`, so the command keeps the terminal, its stdin and its job control
# (research.md D1, measured in O1). What flows past is then just bytes, and
# the relay's job is to let them through, keep a bounded copy, and say when it
# has finished draining — O2's contract: `command_end` is emitted after the
# component that owns the bytes has drained, not by a `precmd` racing it.


def pipe(argv):
    """Pass stdin through to stdout, keep a bounded copy, report at EOF."""
    opts = normalise(parse(argv)[0])
    stream = Stream(sys.stdin, sys.stdout.buffer, opts["max_bytes"])
    while True:
        try:
            if not stream.pump():
                break
        except OSError:
            break
    write_json(opts["event_out"], {
        "stream": opts["stream"],
        "text": stream.text(),
        "bytes": stream.total,
        "truncated": stream.truncated(),
        "cap": opts["max_bytes"],
    })
    return 0


def finish(argv):
    """Merge the two halves into one command_end body, on stdout.

    The shell has already restored its descriptors, which is what gives the
    two `pipe` processes their EOF. Each writes its part file whole and
    renames it into place, so a part that is here is complete; one that is
    missing after the deadline is reported as missing rather than as empty.
    """
    opts = normalise(parse(argv)[0])
    parts = {}
    for name, path in (("stdout", opts["stdout_part"]), ("stderr", opts["stderr_part"])):
        parts[name] = await_part(path, float(opts["drain_timeout"])) if path else None

    cut = []
    drained = True
    for name in ("stdout", "stderr"):
        part = parts[name]
        if part is None:
            drained = False
        elif part.get("truncated"):
            cut.append("%s:%d" % (name, part.get("cap", 0)))

    stdout_bytes = (parts["stdout"] or {}).get("bytes", 0)
    if looks_redirected(opts["command_line"]) and stdout_bytes == 0:
        # `nmap -oN scan.txt` with an empty body and `completeness: complete`
        # reads as a scan that printed nothing, and a reader believes it. The
        # bytes went where the operator sent them; what the record owes is to
        # say so rather than to describe the command as silent (FR-008).
        completeness, disposition = "metadata-only", "redirected"
    elif not drained:
        # Bytes we never got hold of. Saying "complete" here would be the one
        # lie the record cannot afford, and saying nothing would be the other.
        completeness, disposition = "truncated", "captured"
        cut.append("drain-timeout")
    elif cut:
        completeness, disposition = "truncated", "captured"
    else:
        completeness, disposition = "complete", "captured"

    event = {
        "exit_code": int_or(opts["exit_code"], 0),
        "duration_sec": int_or(opts["duration_sec"], 0),
        "cwd": opts["cwd"],
        "stdout": (parts["stdout"] or {}).get("text", ""),
        "stderr": (parts["stderr"] or {}).get("text", ""),
        "stdout_bytes": (parts["stdout"] or {}).get("bytes", 0),
        "stderr_bytes": (parts["stderr"] or {}).get("bytes", 0),
        "stdout_truncated": bool((parts["stdout"] or {}).get("truncated")),
        "stderr_truncated": bool((parts["stderr"] or {}).get("truncated")),
        "captured_by": opts["captured_by"],
        "command_id": opts["command_id"],
        "completeness": completeness,
        "output_disposition": disposition,
        "limit_hit": ",".join(cut) if cut else None,
    }
    if opts["source"]:
        event["source"] = opts["source"]
    sys.stdout.write(json.dumps(event))
    return 0


def looks_redirected(line):
    """Did the operator send this command's stdout somewhere other than here?

    This reads the command LINE — what the operator typed — and never the
    command's output, which is the thing FR-002 forbids reading. The
    distinctions that matter:

      `2> err`   stderr only; stdout still comes past the relay
      `>& file`  a descriptor dup, so the bytes still reach a stream we hold
      `&> file`  both, and stdout is gone
      `| tee f`  not a redirection: the pipeline's last stage still writes here

    Over-reporting is the safe direction — it says the record may not have the
    body — so the one case it declines to guess at is the one where some
    stdout did arrive anyway, which the caller checks separately.
    """
    quote = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote is not None:
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"':
                i += 1
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "\\":
            i += 1
        elif ch == ">":
            if i > 0 and line[i - 1] == ">":
                pass  # the second `>` of `>>`, already judged
            elif i > 0 and line[i - 1] == "2" and (i < 2 or not line[i - 2].isalnum()):
                pass  # `2>` / `2>>`: stderr only
            elif line[i + 1:i + 2] == "&":
                pass  # `>&N`: a dup onto a descriptor the relay still holds
            else:
                return True
        i += 1
    return False


def await_part(path, timeout):
    deadline = time.time() + timeout
    while True:
        try:
            with open(path, "r") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            if time.time() > deadline:
                return None
            time.sleep(0.01)


def classify(argv):
    """Which of the three a command is, from the policy beside this file.

    Here rather than in the adapter because the policy must have exactly one
    home: the shell reads it through this, RedLog reads the same file through
    src/core/terminal-class.ts, and a second copy of the names in shell would
    drift silently until the day it put someone's reverse shell through a
    relay (research.md D7).
    """
    # Everything after `--`. Taking argv as given would classify the separator
    # itself, which is in no list and therefore `relayed` — every command,
    # including `nc`.
    opts, command = parse(argv)
    policy = load_policy(terminal_home(opts))
    i = walk_wrappers(command, policy)
    program = basename(command[i] if i < len(command) else "")
    if program == "":
        # Not a command. `native` and not `relayed`, so a bare Enter does not
        # route the prompt itself through a relay.
        result = "native"
    elif program in policy["pty"]:
        result = "pty"
    elif program in policy["native"]:
        result = "native"
    elif program in policy["repl"]:
        rest = command[i + 1:]
        given = any(a in policy["replScriptFlags"] or not a.startswith("-") for a in rest)
        result = "relayed" if given else "native"
    else:
        result = "relayed"
    sys.stdout.write(result)
    return 0


# ── Per-terminal state (spec 052 US2) ───────────────────────────────────────
#
# Whether THIS terminal is recording, in what mode, and for which project —
# in a file, because the next prompt is a new `preexec` in a shell that has
# kept no memory of the last one, a subshell loses every variable, and RedLog
# has to be able to read the same answer for the capture card. One file, two
# readers, no way for the terminal and the card to disagree (FR-022, FR-023,
# contracts/shell-commands.md rule 2).
#
# The transitions are mirrored from `src/core/terminal-enrollment.ts`: the
# shell cannot call TypeScript and RedLog will not spawn python3 to draw a
# settings panel, so there are two implementations of rules that must agree.
# `test/terminal-enrollment-agreement.test.ts` runs both over the same
# sequences — the same arrangement that caught `classify` reading its own `--`.


def terminal_home(opts):
    return opts["home"] or os.path.expanduser("~")


def terminal_state_path(opts):
    home = terminal_home(opts)
    session = re.sub(r"[^A-Za-z0-9._-]", "_", opts["session"] or "unknown")
    return os.path.join(home, ".redlog", "terminals", session + ".json")


def machine_mode_path(opts):
    return os.path.join(terminal_home(opts), ".redlog", "terminal-mode")


def read_machine_mode(opts):
    """`auto` unless the operator said otherwise. D4: the installed default is
    auto, because a feature whose point is that there is nothing to type is not
    one you opt each terminal into."""
    try:
        with open(machine_mode_path(opts), "r") as fh:
            value = fh.read().strip()
    except OSError:
        return "auto"
    return "manual" if value == "manual" else "auto"


def read_identity(opts):
    """Pinned when the terminal opens, never updated (FR-010). The same file
    `shell-common.sh` embeds in a spooled event."""
    path = os.path.join(terminal_home(opts), ".redlog", "active-identity.json")
    try:
        with open(path, "r") as fh:
            ident = json.load(fh)
    except (OSError, ValueError):
        return "", ""
    return str(ident.get("engagementId", "")), str(ident.get("operatorId", ""))


def read_terminal_state(opts):
    try:
        with open(terminal_state_path(opts), "r") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) and value.get("sessionId") else None


def apply_terminal_action(state, action, opts):
    """Every transition in one place, because the rules only hold together.

    A terminal whose project moved out from under it stays stopped, whatever
    it is asked: letting `redlog start` or `redlog mode auto` undo that would
    make FR-010's pin one keystroke deep, and the failure it prevents is a
    command from engagement A filed under B — a lie in a document a client
    reads.
    """
    pin_broken = state.get("stoppedReason") == "project-switched"
    out = dict(state)
    if action == "stop":
        out["recording"] = False
        out["stoppedReason"] = opts["reason"] or "operator"
    elif action == "start":
        if not pin_broken:
            out["recording"] = True
            out.pop("stoppedReason", None)
    elif action == "mode":
        mode = "manual" if opts["mode"] == "manual" else "auto"
        out["mode"] = mode
        if not pin_broken:
            if mode == "auto":
                out["recording"] = True
                out.pop("stoppedReason", None)
            else:
                out["recording"] = False
                out["stoppedReason"] = "operator"
    elif action == "project":
        if (opts["engagement"] or "") != state.get("engagementId"):
            out["recording"] = False
            out["stoppedReason"] = "project-switched"
    return out


def begin_terminal(opts):
    mode = opts["mode"] or read_machine_mode(opts)
    engagement, operator = read_identity(opts)
    return {
        "sessionId": opts["session"] or "unknown",
        "mode": "manual" if mode == "manual" else "auto",
        "recording": mode != "manual",
        "engagementId": opts["engagement"] or engagement,
        "operatorId": opts["operator"] or operator,
        "startedAt": int(time.time() * 1000),
    }


def human_state(state):
    if state is None:
        return "not enrolled · no state for this terminal"
    recording = state.get("recording") is True
    head = "recording" if recording else "stopped"
    if not recording and state.get("stoppedReason"):
        head += " (%s)" % state["stoppedReason"]
    return "%s · mode %s · project %s · terminal %s" % (
        head, state.get("mode", "auto"),
        state.get("engagementId") or "(none)", state.get("sessionId", ""))


def state_cmd(argv):
    opts = parse(argv)[0]
    action = opts["action"]

    if action == "begin":
        state = read_terminal_state(opts) or begin_terminal(opts)
    elif action in (None, "show"):
        state = read_terminal_state(opts)
    else:
        current = read_terminal_state(opts) or begin_terminal(opts)
        state = apply_terminal_action(current, action, opts)
        if action == "mode":
            # Machine-level, per contracts/shell-commands.md: `redlog mode`
            # switches what a NEW terminal starts as, and applies to this one
            # as well, because an operator who types it means now.
            # With the newline: an operator who `cat`s or edits this should
            # find a normal text file, not one their shell marks as truncated.
            write_text(machine_mode_path(opts), state["mode"] + "\n")

    if action not in (None, "show"):
        write_json(terminal_state_path(opts), state)

    if opts["format"] == "human":
        sys.stdout.write(human_state(state))
    else:
        sys.stdout.write(json.dumps(state) if state is not None else "{}")
    return 0


def write_text(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError:
        pass


CLASS_FIELDS = ("relayed", "pty", "native")


def policy_field(argv):
    """The class policy: read one list, or move a command between classes.

    The adapter installs a wrapper per `pty` program at startup and needs the
    list to do it; `redlog class` edits it. Both go through here rather than
    carrying their own copy, for the same reason the classifier does: one home
    for the names (research.md D7).

    Edits land in an overlay under `~/.redlog/`, never in the shipped
    `hooks/command-class.json` — an install must be able to replace that file
    without taking the operator's choices with it.
    """
    opts = parse(argv)[0]
    action = opts["action"] or ("field" if opts["field"] else "list")

    if action == "field":
        values = load_policy(terminal_home(opts)).get(opts["field"])
        if not isinstance(values, list):
            return 2
        sys.stdout.write("\n".join(str(v) for v in values))
        return 0

    if action == "list":
        policy = load_policy(terminal_home(opts))
        for name in ("native", "pty"):
            sys.stdout.write("%s: %s\n" % (name, " ".join(policy.get(name, []))))
        # `relayed` is not a list — it is what a command is when it is in no
        # other one. Printing a list of "everything else" would be a lie the
        # moment the operator ran something new.
        sys.stdout.write("relayed: everything else\n")
        return 0

    command = basename(opts["command"] or "")
    if not command:
        return 2
    overlay = read_overlay(opts)

    if action == "remove":
        for name in CLASS_FIELDS:
            overlay.setdefault(name, [])
            overlay[name] = [c for c in overlay[name] if c != command]
        overlay.setdefault("removed", [])
        if command not in overlay["removed"]:
            overlay["removed"].append(command)
    elif action == "add":
        target = opts["field"]
        if target not in CLASS_FIELDS:
            return 2
        for name in CLASS_FIELDS:
            overlay.setdefault(name, [])
            overlay[name] = [c for c in overlay[name] if c != command]
        if target != "relayed":
            overlay[target].append(command)
        overlay["removed"] = [c for c in overlay.get("removed", []) if c != command]
    else:
        return 2

    write_json(overlay_path(opts), overlay)
    return 0


def overlay_path(opts):
    return os.path.join(terminal_home(opts), ".redlog", "command-class.json")


def read_overlay(opts):
    try:
        with open(overlay_path(opts), "r") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def walk_wrappers(argv, policy):
    i = 0
    while i < len(argv):
        wrapper = policy["wrappers"].get(basename(argv[i]))
        if wrapper is None:
            break
        i += 1
        while i < len(argv):
            token = argv[i]
            if token == "--":
                i += 1
                break
            if token.startswith("-"):
                i += 2 if token in wrapper else 1
                continue
            if ASSIGNMENT.match(token):
                i += 1
                continue
            break
    return i


def load_policy(home=None):
    """The shipped defaults, with the operator's overlay on top.

    The overlay lives under `~/.redlog/` and the defaults ship beside this
    file, so an install can replace `hooks/command-class.json` without taking
    the operator's choices with it, and `redlog class` never edits a file the
    next install will overwrite.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-class.json")
    with open(path, "r") as fh:
        policy = json.load(fh)
    if home is None:
        return policy
    overlay = read_overlay({"home": home})
    if not overlay:
        return policy
    dropped = set(overlay.get("removed", []))
    for name in CLASS_FIELDS:
        if name == "relayed":
            continue
        base = [c for c in policy.get(name, []) if c not in dropped]
        for command in overlay.get(name, []):
            if command not in base:
                base.append(command)
        policy[name] = base
    # A command the operator moved INTO one class must leave the others.
    for name in CLASS_FIELDS:
        if name == "relayed":
            continue
        moved = {c for other in CLASS_FIELDS if other != name for c in overlay.get(other, [])}
        policy[name] = [c for c in policy.get(name, []) if c not in moved or c in overlay.get(name, [])]
    return policy


def basename(token):
    return token.rsplit("/", 1)[-1]


def int_or(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def write_json(path, payload):
    if not path:
        return
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except OSError:
        pass


def main():
    modes = {"run": run, "pipe": pipe, "finish": finish,
             "classify": classify, "policy": policy_field,
             "state": state_cmd}
    mode = modes.get(sys.argv[1]) if len(sys.argv) > 1 else None
    if mode is None:
        sys.stderr.write(__doc__)
        return 2
    if mode is not run:
        return mode(sys.argv[2:])
    # SIGINT is deliberately left alone: the command is in the relay's
    # foreground process group and receives the Ctrl-C itself, so the relay
    # dying with it is the right behaviour — and `proc.wait()` below still
    # reports the status the shell should see.
    return run(sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
