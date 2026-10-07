#!/usr/bin/env python3
"""RedLog's output relay: run a command, let its bytes through, keep a copy.

This is the body of `redlog-run` (`hooks/shell-common.sh`) lifted out of the
shell. It was a pair of named pipes, two `tee`s and an inline Python event
builder; spec 052 needs the same capture from `preexec`, for every command,
and two implementations of "record a command's output" would drift. One lives
here, both callers use it (research.md D2, Principle III).

Usage:

    redlog-relay.py run --event-out PATH [--max-bytes N] [--cwd DIR]
                        [--captured-by NAME] -- COMMAND [ARG...]

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
import select
import subprocess
import sys
import time

DEFAULT_MAX_BYTES = 102400  # 100 KB per stream, as redlog-run has always used


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
    }
    try:
        # Written whole, then moved into place: a caller that reads a
        # half-written event would record a command that did not happen.
        tmp = opts["event_out"] + ".part"
        with open(tmp, "w") as fh:
            json.dump(event, fh)
        os.replace(tmp, opts["event_out"])
    except OSError:
        # The caller falls back to bare metadata, as it always has. Losing the
        # body is survivable; losing the exit code is not, and that one the
        # shell already holds.
        pass
    return code


def parse(argv):
    opts = {
        "event_out": None,
        "max_bytes": DEFAULT_MAX_BYTES,
        "cwd": os.getcwd(),
        "captured_by": "redlog-relay",
    }
    flags = {
        "--event-out": "event_out",
        "--max-bytes": "max_bytes",
        "--cwd": "cwd",
        "--captured-by": "captured_by",
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


def main():
    if len(sys.argv) < 2 or sys.argv[1] != "run":
        sys.stderr.write(__doc__)
        return 2
    # SIGINT is deliberately left alone: the command is in the relay's
    # foreground process group and receives the Ctrl-C itself, so the relay
    # dying with it is the right behaviour — and `proc.wait()` below still
    # reports the status the shell should see.
    return run(sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
