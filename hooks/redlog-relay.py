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
    redlog-relay.py pty --dir DIR --err-fd N [--max-bytes N]
    redlog-relay.py finish --stdout-part A --stderr-part B [...]   -> JSON

        The zsh adapter: it diverts the SHELL's stdout and stderr in `preexec`
        and restores them in `precmd`, so the command itself is never launched
        by anything here and keeps its terminal, stdin and job control. What
        it is handed in place of the terminal is a pseudo-terminal, not a pipe
        — see `pty_pipe`.

    redlog-relay.py detect --home DIR [--session ID] [--shell NAME]

        Once per shell, at its first prompt, in the background: which of the
        tool profiles' executables the shell's own PATH reaches, written as one
        small report per kind of shell for RedLog to display (#499). Nothing
        in this file reads a report back; what a command is recorded as never
        depends on what was found.

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
import errno
import base64
import json
import os
import re
import select
import shlex
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terminal_app import terminal_app_allowed
import time
import queue
import threading

DEFAULT_MAX_BYTES = 102400  # 100 KB per stream, as redlog-run has always used

_TRACE_MAX_BYTES = 2 * 1024 * 1024


def _trace_target():
    """The debug log, when Settings > About > Debug log is on (same switch and
    file as redlog-session.py: ~/.redlog/debug-enabled -> ~/.redlog/debug.log).
    REDLOG_SESSION_TRACE=<file> overrides it. Decided once per process."""
    explicit = os.environ.get("REDLOG_SESSION_TRACE")
    if explicit:
        return explicit
    home = os.path.join(os.path.expanduser("~"), ".redlog")
    return os.path.join(home, "debug.log") if os.path.exists(os.path.join(home, "debug-enabled")) else None


_TRACE = _trace_target()


def trace(event, detail=""):
    """One line per completeness decision. Counts and verdicts only — never the
    command, its cwd or what it printed, so the file can be attached to an
    issue. A write failure is ignored: tracing must not change the command."""
    if not _TRACE:
        return
    import datetime
    try:
        try:
            if os.path.getsize(_TRACE) > _TRACE_MAX_BYTES:
                os.replace(_TRACE, _TRACE + ".1")
        except OSError:
            pass
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp = now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)
        with open(_TRACE, "a") as out:
            out.write("%s relay %s %spid=%d\n" % (stamp, event, detail + " " if detail else "", os.getpid()))
    except OSError:
        pass

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
        self.first_seen = None
        # Set once the command's record has been written and a background
        # writer is still on this descriptor: from then on the bytes belong to
        # the late-output sender, not to `kept`.
        self.late = None
        self.capture = None
        self.stream_name = None

    def pump(self):
        chunk = os.read(self.source.fileno(), 65536)
        if not chunk:
            return False
        observed = int(time.time() * 1000)
        if self.first_seen is None:
            self.first_seen = observed
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
        if self.late is not None:
            self.late.feed(chunk, observed)
            return True
        self.total += len(chunk)
        if self.capture and self.capture.active:
            self.capture.feed(self.stream_name, chunk, observed)
            return True
        cap = max(self.cap, self.total) if self.capture and self.capture.enabled else self.cap
        room = cap - len(self.kept)
        if room > 0:
            self.kept.extend(chunk[:room])
        if self.capture:
            self.capture.maybe_start()
        return True

    def text(self):
        # Invalid UTF-8 becomes U+FFFD rather than an exception. The command
        # whose output is not text is exactly the one worth having recorded.
        return "" if self.capture and self.capture.active else self.kept.decode("utf-8", errors="replace")

    def truncated(self):
        return self.total > self.cap and not (self.capture and self.capture.active)


class LateOutput:
    """What a command's background jobs print after its record was written.

    `nmap -p- host &` returns the prompt at once and keeps printing for
    minutes. The relay used to wait for that to finish before the prompt could
    return (about ten seconds, then give up), and the record held whatever had
    arrived by then. The record has to be whole, so the body that existed when
    the prompt came back is `command_end`, marked `partial`, and everything
    after it is sent here as `command_output` chunks carrying the same
    command_id — attributed by the pty pair that was opened for that command,
    never by reading the bytes (FR-002). `command_end` is not edited: it is
    already in the chain.

    Chunks end on a line boundary so cleaning (colour, redrawn lines) does not
    cut an escape sequence in half. The identity is pinned when the late
    output begins; a project switch or a paused recording makes the server
    refuse, and refused bytes are counted, never replayed into another
    interval. Bytes are never lost silently: `dropped_bytes` on the final row.
    """

    FLUSH_BYTES = 16384
    FLUSH_SECONDS = 1.0
    STALE_PARTIAL_SECONDS = 5.0
    RETRY_MAX = 64

    def __init__(self, opts):
        self.foreground = opts.get("foreground", False)
        self.command_id = opts["command_id"]
        self.source = opts["source"]
        self.captured_by = opts["captured_by"]
        self.cap = max(4, min(int(opts["max_bytes"]), 65536))
        self.seq = 0
        self.kept_bytes = 0
        self.over_cap = 0
        self.dropped = 0
        self.truncated = False
        self.bufs = {"stdout": bytearray(), "stderr": bytearray()}
        self.since = {"stdout": 0.0, "stderr": 0.0}
        self.source_since = {"stdout": 0, "stderr": 0}
        self.pending = []
        self.client = self._client(opts)
        trace("late-start", "client=%s" % ("yes" if self.client else "no"))

    @staticmethod
    def _client(opts):
        from pathlib import Path

        try:
            directory = Path(terminal_home(opts)) / ".redlog"
            identity = json.loads((directory / "active-identity.json").read_text())
            return {
                "engagement": identity["engagementId"],
                "token": (directory / "api-token").read_text().strip(),
                "url": "http://127.0.0.1:%d/api/events" % int((directory / "api-port").read_text()),
                "opener": None,
            }
        except (OSError, ValueError, KeyError):
            return None

    def feed(self, stream_name, chunk):
        if not terminal_app_allowed():
            self.dropped += len(chunk) + sum(len(b) for b in self.bufs.values())
            self.bufs = {"stdout": bytearray(), "stderr": bytearray()}
            self.pending.clear()
            return
        buf = self.bufs[stream_name]
        if not buf:
            self.since[stream_name] = time.time()
            self.source_since[stream_name] = getattr(self, "observed", int(time.time() * 1000))
        buf.extend(chunk)
        if len(buf) >= min(self.FLUSH_BYTES, self.cap):
            self.flush(stream_name)

    def tick(self):
        now = time.time()
        for name, buf in self.bufs.items():
            if not buf:
                continue
            age = now - self.since[name]
            if (age >= self.FLUSH_SECONDS and b"\n" in buf) or age >= self.STALE_PARTIAL_SECONDS:
                self.flush(name, whole=age >= self.STALE_PARTIAL_SECONDS)
        self.retry()

    def flush(self, name, whole=False):
        buf = self.bufs[name]
        if not buf:
            return
        while buf:
            ceiling = min(len(buf), self.cap)
            cut = ceiling if whole or ceiling == self.cap else buf.rfind(b"\n", 0, ceiling) + 1
            if cut <= 0:
                return
            # The reader's text must not acquire a replacement character just
            # because a valid UTF-8 codepoint crossed a segment boundary.
            while cut < len(buf) and buf[cut] & 0xC0 == 0x80 and cut > 0:
                cut -= 1
            if cut <= 0:
                cut = ceiling  # arbitrary binary, byte counts remain exact
            raw = bytes(buf[:cut])
            del buf[:cut]
            self.since[name] = time.time()
            self.kept_bytes += len(raw)
            self.seq += 1
            self.pending.append(self._payload({
                "seq": self.seq, "stream": name, "bytes": len(raw),
                "source_timestamp": self.source_since[name],
                "output_body": {"data": base64.b64encode(raw).decode("ascii"), "encoding": "base64", "size": len(raw), "sha256": ""},
                name: clean(raw.decode("utf-8", errors="replace")),
                "final": False,
            }))
            self.retry()
            if not whole and len(buf) < min(self.FLUSH_BYTES, self.cap):
                return

    def _payload(self, extra):
        data = {
            "subtype": "command_output", "command_id": self.command_id, "late": not self.foreground,
            "captured_by": self.captured_by, "timestamp": getattr(self, "observed", int(time.time() * 1000)),
        }
        if self.foreground:
            data["streamed"] = True
        if self.source:
            data["source"] = self.source
        data["source_timestamp"] = data["timestamp"]
        data.update(extra)
        return {"agent_type": "shell", "data": data}

    def retry(self):
        while self.pending:
            verdict = self._send(self.pending[0])
            if verdict == "failed":
                if len(self.pending) > self.RETRY_MAX:
                    self._drop(self.pending.pop(0))
                return
            sent = self.pending.pop(0)
            if verdict != "accepted":
                self._drop(sent)

    def _drop(self, payload):
        self.dropped += int(payload["data"].get("bytes", 0))

    def _send(self, payload):
        if not terminal_app_allowed():
            return "refused"
        if not self.client:
            return "refused"
        import urllib.error
        import urllib.request

        if self.client["opener"] is None:
            self.client["opener"] = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(
            self.client["url"], json.dumps(payload).encode(),
            {"Content-Type": "application/json", "Authorization": "Bearer " + self.client["token"],
             "X-Redlog-Engagement": self.client["engagement"]})
        try:
            with self.client["opener"].open(request, timeout=1) as response:
                result = json.load(response)
            return "paused" if result.get("recording") is False else "accepted"
        except urllib.error.HTTPError as error:
            # The row may have committed before a lost response; a replayed
            # command+seq is acknowledged by the API as its duplicate.
            if error.code == 409:
                try:
                    if json.load(error).get("error") == "Duplicate event (dedup window)":
                        return "accepted"
                except (ValueError, OSError):
                    pass
            return "refused"
        except Exception:
            return "failed"

    def finish(self):
        for name in ("stdout", "stderr"):
            self.flush(name, whole=True)
        # Settle data before constructing the summary: retries can still be
        # refused or dropped, and a summary frozen earlier would undercount it.
        for _ in range(3):
            self.retry()
            if not self.pending:
                break
            time.sleep(0.1)
        unsent = len(self.pending)
        for payload in self.pending:
            self._drop(payload)
        self.pending.clear()
        self.observed = int(time.time() * 1000)
        self.seq += 1
        self.pending.append(self._payload({
            "seq": self.seq, "stream": "both", "final": True, "bytes": 0,
            "late_bytes": self.kept_bytes, "truncated": self.truncated or self.dropped > 0,
            "over_cap_bytes": self.over_cap, "dropped_bytes": self.dropped,
        }))
        self.retry()
        trace("late-end", "kept=%d dropped=%d over_cap=%d truncated=%s unsent=%d" % (
            self.kept_bytes, self.dropped, self.over_cap, self.truncated, unsent))

    def stream_tap(self, name):
        late = self

        class Tap:
            def feed(self, chunk, observed=None):
                if observed is not None:
                    late.observed = observed
                late.feed(name, chunk)
        return Tap()


class ForegroundOutput:
    """Bounded asynchronous transport: network stalls never block the PTY pump.

    Small commands keep the existing inline path. After 16 KiB or one second,
    the retained prefix and following bytes move to the same ordered output
    records used for background jobs. Refused/paused bytes are never replayed.
    """
    def __init__(self, opts, streams):
        self.streams = streams
        self.sender = LateOutput({**opts, "foreground": True, "max_bytes": 65536})
        self.enabled = bool(self.sender.client and opts.get("command_id"))
        self.active = False
        self.started = time.monotonic()
        self.threshold = min(16384, max(1, int(opts["max_bytes"])))
        self.pending = queue.Queue(maxsize=64)
        self.stopping = threading.Event()
        self.thread = None
        self.dropped = 0
        for name, stream in streams.items():
            stream.capture = self
            stream.stream_name = name

    def maybe_start(self):
        if not self.enabled or self.active:
            return
        size = sum(stream.total for stream in self.streams.values())
        if size == 0 or (size < self.threshold and time.monotonic() - self.started < 1):
            return
        # An identity/token file is not proof that a receiver is listening.
        # Do not discard the bounded inline record for a dead local port:
        # the shell can still spool that record. This bounded loopback
        # connection check has a 5 ms ceiling, not the HTTP retry deadline.
        import errno
        import socket
        from urllib.parse import urlsplit
        try:
            port = urlsplit(self.sender.client['url']).port
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setblocking(False)
                status = probe.connect_ex(('127.0.0.1', port))
                ready = status == 0 or (status in (errno.EINPROGRESS, errno.EWOULDBLOCK)
                    and bool(select.select([], [probe], [], 0.005)[1])
                    and probe.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0)
        except (OSError, ValueError, TypeError):
            ready = False
        if not ready:
            self.enabled = False
            for stream in self.streams.values():
                del stream.kept[stream.cap:]
            return
        self.active = True
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()
        for name, stream in self.streams.items():
            raw = bytes(stream.kept)
            # The initial read can exceed a deliberately tiny preview budget.
            # pump supplies that read separately (below); never claim its lost
            # suffix was streamed just because the prefix was.
            self.feed(name, raw, stream.first_seen)
            self.dropped += stream.total - len(raw)
            stream.kept.clear()

    def feed(self, name, raw, observed=None):
        if not raw:
            return
        try:
            self.pending.put_nowait((name, raw, observed if observed is not None else int(time.time() * 1000)))
        except queue.Full:
            self.dropped += len(raw)

    def tick(self):
        self.maybe_start()

    def drain(self):
        while not self.stopping.is_set() or not self.pending.empty():
            try:
                name, raw, observed = self.pending.get(timeout=0.1)
            except queue.Empty:
                self.sender.tick()
                continue
            self.sender.observed = observed
            self.sender.feed(name, raw)
            self.sender.tick()
        self.sender.dropped += self.dropped
        self.sender.finish()

    def finish(self):
        if not self.active:
            return
        self.stopping.set()
        self.thread.join(timeout=4)
        if self.thread.is_alive():
            trace("foreground-unfinished", "pending=%d dropped=%d" % (self.pending.qsize(), self.dropped))

    def stream_tap(self, name):
        capture = self
        class Tap:
            def feed(self, chunk, observed=None):
                capture.feed(name, chunk, observed)
        return Tap()


def run(argv):
    import subprocess

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
    capture = ForegroundOutput(opts, {"stdout": out, "stderr": err})
    live = {proc.stdout.fileno(): out, proc.stderr.fileno(): err}
    while live:
        ready, _, _ = select.select(list(live), [], [], 0.2)
        capture.tick()
        for fd in ready:
            stream = live[fd]
            try:
                alive = stream.pump()
            except OSError:
                alive = False
            if not alive:
                del live[fd]
    capture.finish()
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
    seen = [stream.first_seen for stream in (out, err) if stream and stream.first_seen is not None]
    if seen:
        event["output_started_at"] = min(seen)
    if out and out.capture and out.capture.active:
        event["output_streamed"] = True
        event["completeness"] = "partial"
        event["output_stream_dropped"] = out.capture.dropped + out.capture.sender.dropped
        event.pop("stdout", None); event.pop("stderr", None)
    # Written whole, then moved into place: a caller that reads a half-written
    # event would record a command that did not happen. If the write fails the
    # caller falls back to bare metadata, as it always has — losing the body is
    # survivable, losing the exit code is not, and the shell already holds that.
    write_json(opts["event_out"], event)
    trace("run-emit", "exit=%d completeness=%s disposition=%s stdout_bytes=%d stderr_bytes=%d limit_hit=%s" % (
        code, completeness, disposition, event["stdout_bytes"], event["stderr_bytes"], event["limit_hit"] or "-"))
    return code


def parse(argv):
    opts = {
        "event_out": None,
        "max_bytes": DEFAULT_MAX_BYTES,
        "cwd": os.getcwd(),
        "captured_by": "redlog-relay",
        "command_id": None,
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
        "dir": None,
        "err_fd": "2",
        "owner": None,
        "notify": None,
        "shell": None,
    }
    flags = {
        "--shell": "shell",
        "--dir": "dir",
        "--err-fd": "err_fd",
        "--owner": "owner",
        "--notify": "notify",
        "--event-out": "event_out",
        "--max-bytes": "max_bytes",
        "--cwd": "cwd",
        "--captured-by": "captured_by",
        "--command-id": "command_id",
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


def window_size(path="/dev/tty"):
    """The real terminal's size as the 8 bytes TIOCSWINSZ takes, or None."""
    # Imported here, not at the top: `classify` and `finish` run wherever
    # Python does, and these two modules exist only on POSIX.
    import fcntl
    import termios
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOCTTY)
    except OSError:
        return None
    try:
        return fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
    except OSError:
        return None
    finally:
        os.close(fd)


def pty_pipe(argv):
    """Pass the command's stdout and stderr through to the real terminal, keep
    a bounded copy of each, and report at EOF — through a pseudo-terminal per
    stream, which is what the command is given instead of a pipe.

    A pipe tells the command that nobody is watching: `isatty` is false, `ls`
    prints one name a line and no colour, `git` drops its colour, Python's
    `get_terminal_size` raises ENOTTY. The operator sees a different shell with
    the recorder on (issue #288, measured in test/zsh-transparency.pty.test.ts).
    A pseudo-terminal answers all of that the way the real one does, and it
    leaves everything that matters to `nc` alone: only the command's stdout and
    stderr are given one. Its stdin stays the real terminal, so job control and
    Ctrl-C and Ctrl-Z go where they always went.

    Two of them, not one, so stdout and stderr stay separable. A single pty
    would be the terminal's own merge and a record that claimed otherwise
    (FR-005).

    The hand-over: this process makes the pair and says where the slave side
    is; the shell opens it and says so. Keep our slave copies until the shell
    signals completion AND queued output has been drained: macOS flushes unread
    master data when the last slave closes. A short command may already have
    closed its copies before this process even observes the hand-over. Once
    drained, release ours so remaining writers can still determine real EOF.
    """
    import fcntl
    import termios
    # Nothing past stderr is ours. bash starts the relay from its DEBUG trap,
    # which runs after the shell has made the pipe of `a | b` and before it
    # forks either side, so the relay is born holding that pipe's write end and
    # `b` never sees EOF: `echo x | cat` hung the prompt. The shell cannot name
    # the descriptor, so the relay lets go of everything it was not handed.
    # `--err-fd` is 3 by contract; the pty pairs are opened below, after this.
    os.closerange(4, 4096)
    opts = normalise(parse(argv)[0])
    directory = opts["dir"]
    err_sink = os.fdopen(int(opts["err_fd"]), "wb", buffering=0)

    legs = []
    names = []
    for stream_name, sink in (("stdout", sys.stdout.buffer), ("stderr", err_sink)):
        master, slave = os.openpty()
        # Bytes go through unchanged. The slave would otherwise turn every \n
        # into \r\n on its way to the master, and the real terminal does the
        # same again on the way out — the record would hold bytes the command
        # never wrote.
        attrs = termios.tcgetattr(slave)
        attrs[1] &= ~termios.OPOST
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        legs.append({
            "name": stream_name,
            "master": master,
            "slave": slave,
            "stream": Stream(os.fdopen(master, "rb", buffering=0, closefd=False), sink, opts["max_bytes"]),
        })
        names.append(os.ttyname(slave))

    capture = ForegroundOutput(opts, {leg["name"]: leg["stream"] for leg in legs})

    def sync_size():
        size = window_size()
        if size is None:
            return
        for leg in legs:
            try:
                fcntl.ioctl(leg["master"], termios.TIOCSWINSZ, size)
            except OSError:
                pass

    sync_size()
    write_text(os.path.join(directory, "pts"), "\n".join(names))
    # A shell that cannot wait without starting a process (bash 3.2: `read -t`
    # takes whole seconds, and a `sleep` is a foreground job that Ctrl-C lands
    # on) opens a FIFO read-write, and is woken by one byte here. Best effort:
    # a shell that gave up has closed it, and polling `pts` still works.
    if opts["notify"]:
        try:
            fd = os.open(opts["notify"], os.O_WRONLY | os.O_NONBLOCK)
            try:
                os.write(fd, b"1\n")
            finally:
                os.close(fd)
        except OSError:
            pass

    # The shell is slow to say it has opened them, or has died; either way
    # this must not wait for ever.
    opened = os.path.join(directory, "opened")
    closed = os.path.join(directory, "closed")
    # The shell, by pid. Its parent is the default because zsh starts the relay
    # as its own child; bash starts it from a throwaway subshell (so the shell
    # prints no job notice), and that subshell is gone before the command ends,
    # which would read as "the owner died" and close the ptys under the command.
    owner = int(opts["owner"]) if opts["owner"] else os.getppid()
    late = None
    released_at = None
    deadline = time.time() + float(opts["drain_timeout"])
    while not os.path.exists(opened):
        if time.time() > deadline:
            return 1
        time.sleep(0.005)
    while legs:
        if late is None:
            capture.tick()
        # Also notice the file-based completion signal promptly. Waiting a
        # quarter second here would add that delay to every short command.
        ready, _, _ = select.select([leg["master"] for leg in legs], [], [], 0.05)
        # A resize while a command is running: the shell's own terminal is
        # resized, and only the foreground process group is told. This
        # process is not in it, so it looks.
        sync_size()
        retry_read = False
        for leg in list(legs):
            if leg["master"] not in ready:
                continue
            try:
                alive = leg["stream"].pump()
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                alive = False
            if not alive:
                # While we retain a slave, an EOF/EIO cannot be the final
                # stream boundary. Drain first, then release it below.
                if leg["slave"] is not None:
                    retry_read = True
                    continue
                # A transient read-side hangup is not a command boundary.
                # Closing the master here makes the shell's next write fail
                # with EIO. The adapter signals completion after restoring
                # its descriptors; a dead owner also ends the interval.
                if os.path.isdir(directory) and not os.path.exists(closed):
                    try:
                        os.kill(owner, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        retry_read = True
                        continue
                legs.remove(leg)
                os.close(leg["master"])
                # A suspended/background job may still write after the shell
                # times out its drain and removes the work directory. Keep
                # forwarding until EOF, but do not recreate retired evidence.
                # A leg whose record was already written as a snapshot is not
                # written again: what came after went out as chunks.
                if leg["stream"].late is None and os.path.isdir(directory):
                    write_json(os.path.join(directory, leg["name"] + ".json"), {
                        "stream": leg["name"],
                        "text": leg["stream"].text(),
                        "bytes": leg["stream"].total,
                        "truncated": leg["stream"].truncated(),
                        "streamed": capture.active,
                        "observed_at": leg["stream"].first_seen,
                        "cap": opts["max_bytes"],
                    })
        if not ready:
            completed = os.path.exists(closed) or not os.path.isdir(directory)
            if not completed:
                try:
                    os.kill(owner, 0)
                except ProcessLookupError:
                    completed = True
            if completed:
                # The empty poll above may predate completion: the command
                # can write and close while this process is descheduled.
                # Observe the boundary first, THEN prove its queue is empty.
                if select.select([leg["master"] for leg in legs], [], [], 0)[0]:
                    continue
                # No queued bytes remain, and the foreground command cannot
                # produce more. Closing our copies now cannot flush its body.
                # If a background writer survives, keep forwarding until EOF
                # or the caller retires this interval after its drain timeout.
                for leg in legs:
                    if leg["slave"] is not None:
                        os.close(leg["slave"])
                        leg["slave"] = None
                        released_at = released_at or time.time()
        # A leg that is still open a moment after we let go of our slave has a
        # writer that is not the foreground command: a background job. Record
        # what the command printed up to now, so the prompt is not held for it,
        # and send the rest as it comes. A leg with no writer reads EOF at once
        # and takes the normal path above; the grace keeps a snapshot from
        # being written for it.
        if legs and released_at and late is None and time.time() - released_at > 0.3 \
                and os.path.isdir(directory):
            late = capture if capture.active else LateOutput(opts)
            for leg in legs:
                stream = leg["stream"]
                write_json(os.path.join(directory, leg["name"] + ".json"), {
                    "stream": leg["name"],
                    "text": stream.text(),
                    "bytes": stream.total,
                    "truncated": stream.truncated(),
                    "streamed": capture.active,
                    "observed_at": stream.first_seen,
                    "cap": opts["max_bytes"],
                    "background": True,
                })
                stream.late = late.stream_tap(leg["name"])
            trace("late-snapshot", "legs=%d" % len(legs))
        if late is not None:
            late.tick()
        if retry_read:
            time.sleep(0.01)
    if late is not None:
        late.finish()
    elif capture.active:
        capture.finish()
    return 0


# What a person reads is not what the terminal was sent. Colour and cursor
# sequences carry nothing a reader of a pentest record wants, and a progress
# bar is one line that was redrawn forty times. The bytes were let through
# untouched on the way to the screen; this is only the stored copy.
ESCAPES = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"      # OSC: window titles, hyperlinks
    r"|\x1b\[[0-?]*[ -/]*[@-~]"                 # CSI: colour, cursor, erase
    r"|\x1b[@-Z\\-_]"                           # two-byte escapes
)


def clean(text):
    text = ESCAPES.sub("", text).replace("\r\n", "\n")
    if "\r" not in text:
        return text
    # A bare \r returns to the start of the line, so the last thing written
    # after it is what was on screen when the line ended.
    lines = []
    for line in text.split("\n"):
        parts = [p for p in line.split("\r") if p]
        lines.append(parts[-1] if parts else "")
    return "\n".join(lines)


def finish(argv):
    """Merge the two halves into one command_end body, on stdout.

    The shell has already restored its descriptors, which is what gives the
    relay its EOF. It writes each part file whole and renames it into place, so a part that is here is complete; one that is
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
    background = any(p and p.get("background") for p in parts.values())
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
    elif background:
        # A background job still holds the terminal. What this row carries is
        # what had been printed when the prompt came back; the rest follows as
        # `command_output` rows with this command_id (`late_output`).
        completeness, disposition = "partial", "captured"
    elif cut:
        completeness, disposition = "truncated", "captured"
    else:
        completeness, disposition = "complete", "captured"

    event = {
        "exit_code": int_or(opts["exit_code"], 0),
        "duration_sec": int_or(opts["duration_sec"], 0),
        "cwd": opts["cwd"],
        "stdout": clean((parts["stdout"] or {}).get("text", "")),
        "stderr": clean((parts["stderr"] or {}).get("text", "")),
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
    seen = [p["observed_at"] for p in parts.values() if p and isinstance(p.get("observed_at"), int)]
    if seen:
        event["output_started_at"] = min(seen)
    if any(p and p.get("streamed") for p in parts.values()):
        event["output_streamed"] = True
        event["completeness"] = "partial"
        event.pop("stdout", None); event.pop("stderr", None)
    if background:
        event["late_output"] = True
    if opts["source"]:
        event["source"] = opts["source"]
    trace("finish", "exit=%s completeness=%s disposition=%s stdout_bytes=%d stderr_bytes=%d drained=%s limit_hit=%s" % (
        event["exit_code"], completeness, disposition, event["stdout_bytes"], event["stderr_bytes"],
        drained, event["limit_hit"] or "-"))
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
    line = opts["command_line"]
    result = classify_line(line, policy) if line else None
    if result is None:
        result = classify_argv(command, policy)
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
        # No `--engagement` means "whatever RedLog has open now", which is the
        # question the adapter is actually asking at each prompt. Defaulting to
        # the empty string instead would read as a switch every time.
        current = opts["engagement"] or read_identity(opts)[0]
        if current != state.get("engagementId"):
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
    head = "recording enabled" if recording else "stopped"
    if recording and not state.get("engagementId"):
        head = "not recording (no project; open a project and a new terminal)"
    elif recording and not state.get("operatorId"):
        head = "not recording (missing operator identity; open a project and a new terminal)"
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
        shipped = read_shipped()
        contributed = read_contributed_file(terminal_home(opts))
        policy = build_policy(shipped, read_overlay_file(terminal_home(opts)), contributed)
        for name in ("native", "pty"):
            sys.stdout.write("%s: %s\n" % (name, " ".join(policy.get(name, []))))
        # `relayed` is not a list — it is what a command is when it is in no
        # other one. Printing a list of "everything else" would be a lie the
        # moment the operator ran something new.
        sys.stdout.write("relayed: everything else\n")
        for line in policy_notes(shipped.get("terminalProfiles", []), normalize_contributed(contributed)[0], policy):
            sys.stdout.write(line + "\n")
        return 0

    given = opts["command"] or ""
    if not given or action not in ("add", "remove"):
        return 2
    command = basename(given)
    target = opts["field"]
    if action == "add" and target not in CLASS_FIELDS:
        return 2
    # Not a name the wrapper can be built from: refused before anything is
    # written, with its own status so the hook can say so (2 is "no such class").
    # `foo/` is one: nothing is left of it once the directory is taken off.
    if (action == "add" and not EXECUTABLE.fullmatch(command)) or (action == "remove" and not command):
        sys.stderr.write("redlog-relay: %r is not a bare command name\n" % given)
        return 3
    # Read through the same normalization the compiler uses, so a hand-edited
    # field that is not a list is rewritten here instead of crashing the edit.
    # A file that cannot be read at all is not an empty overlay: the edit
    # rewrites the whole file, so it would replace what the operator wrote with
    # one line of what they just did. It is left as it is (4).
    path = overlay_path(opts)
    try:
        raw = read_json_capped(path)
    except FileNotFoundError:
        raw = None
    except (OSError, ValueError) as exc:
        sys.stderr.write("redlog-relay: %s cannot be read (%s); it was not changed. "
                         "Fix or delete it, then run this again.\n" % (path, exc))
        return 4
    overlay = dict(raw) if isinstance(raw, dict) else {}
    overlay.update(normalize_overlay(raw)[0])

    # `remove` undoes the operator's own edit and nothing else, so the command
    # is back where the shipped defaults put it. Taking a command out of its
    # default class is `add relayed`, which has to be recorded too: relayed is
    # not a list in the defaults, but an override to it must be (#296).
    if action == "remove":
        for name in CLASS_FIELDS:
            overlay.setdefault(name, [])
            overlay[name] = [c for c in overlay[name] if c != command]
    elif action == "add":
        for name in CLASS_FIELDS:
            overlay.setdefault(name, [])
            overlay[name] = [c for c in overlay[name] if c != command]
        overlay[target].append(command)
    overlay.pop("removed", None)

    write_json(overlay_path(opts), overlay)
    return 0


def overlay_path(opts):
    return os.path.join(terminal_home(opts), ".redlog", "command-class.json")


# The most either file under ~/.redlog that the policy reads may hold. Both are
# written by RedLog and are a few KB; anything bigger was not written by it, and
# is read as not readable instead of being parsed. Mirrored by
# CLASS_FILE_MAX_BYTES in src/core/terminal-class.ts.
MAX_CLASS_FILE_BYTES = 1024 * 1024

# How deep either file may nest. RedLog's own are four levels deep. Python's
# parser gives up near a thousand levels with RecursionError and V8 parses any
# depth, so an explicit cap is what makes "too deep" one answer on both sides.
# Mirrored by CLASS_FILE_MAX_DEPTH in src/core/terminal-class.ts.
MAX_CLASS_JSON_DEPTH = 32


def nests_deeper_than(value, limit=MAX_CLASS_JSON_DEPTH):
    """Whether a parsed value nests deeper than `limit` containers. Iterative."""
    stack = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, dict):
            children = node.values()
        elif isinstance(node, list):
            children = node
        else:
            continue
        if depth > limit:
            return True
        stack.extend((child, depth + 1) for child in children)
    return False


def refuse_constant(name):
    raise ValueError("not JSON: %s" % name)


def read_json_capped(path):
    """JSON from a file the policy reads, or ValueError when it cannot be used.

    FileNotFoundError and other OSErrors pass through. A file over the cap is
    not read past it, and a file nested so deep that json recurses out of stack
    (RecursionError, which is not a ValueError) is the same refusal: a hand-edit
    must not be able to stop `classify` and `--field pty` with a traceback,
    which leaves zsh without PTY wrappers and every command native, silently.

    Three more things JSON.parse in the app refuses, and so must this: NaN and
    Infinity, which Python's parser takes unless told not to; a byte that is not
    UTF-8, which the strict decode refuses (the app decodes the same way); and a
    byte order mark, which is not JSON in either.
    """
    with open(path, "rb") as fh:
        data = fh.read(MAX_CLASS_FILE_BYTES + 1)
    if len(data) > MAX_CLASS_FILE_BYTES:
        raise ValueError("file is larger than %d bytes" % MAX_CLASS_FILE_BYTES)
    try:
        parsed = json.loads(data.decode("utf-8"), parse_constant=refuse_constant)
    except RecursionError:
        raise ValueError("nested too deeply")
    if nests_deeper_than(parsed):
        raise ValueError("nested too deeply")
    return parsed


def read_overlay_file(home):
    """The operator's overlay exactly as parsed, or None when there is none.

    Not coerced to a dict: whether it is usable is normalize_overlay's call,
    so that a file that is not an object and a file that is both get one rule.
    """
    try:
        return read_json_capped(overlay_path({"home": home}))
    except (OSError, ValueError):
        return None


def classify_argv(command, policy):
    i = walk_wrappers(command, policy)
    program = basename(command[i] if i < len(command) else "")
    if program == "":
        # Not a command. `native` and not `relayed`, so a bare Enter does not
        # route the prompt itself through a relay.
        return "native"
    if program in policy["pty"]:
        return "pty"
    if program in policy["native"]:
        return "native"
    if program in policy["repl"]:
        rest = command[i + 1:]
        given = any(a in policy["replScriptFlags"] or not a.startswith("-") for a in rest)
        return "relayed" if given else "native"
    return "relayed"


def classify_line(line, policy):
    """The shapes the relay has to decline, decided from the whole line.

    FR-029. The relay holds the shell's descriptors for the duration of the
    command, so what matters is not only what the first word is:

      `cat log | less`   classified on `cat` this is relayed, and then the
                         pager's stdout is a pipe instead of a terminal — it
                         stops being a pager. Any native or pty stage anywhere
                         in a pipeline stands the whole line down.
      `nmap | tee f`     is NOT a hazard and is worth capturing: the last
                         stage still writes to the terminal, which is exactly
                         what the relay is holding.
      `nmap -oN f > out` the operator has already pointed stdout somewhere
                         else, so there is nothing for the relay to hold.
                         Standing down saves starting two processes to watch
                         an empty descriptor; the record says `redirected`
                         either way (FR-008).

    Returns None when the line says nothing special and the argv path decides.
    """
    if looks_redirected(line):
        return "redirected"
    stages = split_pipeline(line)
    if len(stages) < 2:
        return None
    for stage in stages:
        try:
            words = shlex.split(stage)
        except ValueError:
            # Unbalanced quotes: zsh would not have run this as we read it, so
            # the safe answer is to hold nothing.
            return "native"
        if classify_argv(words, policy) in ("native", "pty"):
            return "native"
    return "relayed"


def split_pipeline(line):
    """Split on `|` outside quotes. `||` is not a pipeline."""
    stages = []
    current = []
    quote = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote is not None:
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"':
                current.append(ch)
                i += 1
                if i < len(line):
                    current.append(line[i])
                i += 1
                continue
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "\\":
            current.append(ch)
            i += 1
            if i < len(line):
                current.append(line[i])
            i += 1
            continue
        elif ch == "|":
            if line[i + 1:i + 2] == "|":
                # `a || b` is two commands, not a pipeline, and neither half
                # has the other's stdout.
                current.append(ch)
                current.append("|")
                i += 2
                continue
            stages.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    stages.append("".join(current))
    return [s.strip() for s in stages if s.strip()]


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


def read_shipped():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "command-class.json")
    with open(path, "r") as fh:
        return json.load(fh)


def contributed_path(opts):
    return os.path.join(terminal_home(opts), ".redlog", "terminal-profiles.json")


def read_contributed_file(home):
    """The plugins' snapshot exactly as parsed: None when there is no file,
    False when it cannot be read or parsed, else what it parsed to.

    Not coerced: whether it is usable is normalize_contributed's call. What
    cannot be read is decided in read_json_capped, the same for the overlay.
    """
    try:
        return read_json_capped(contributed_path({"home": home}))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return False


def load_policy(home=None):
    """The shipped policy compiled with the operator's overlay on top, and the
    plugins' snapshot beside it.

    The overlay and the snapshot live under `~/.redlog/` and the defaults ship
    beside this file, so an install can replace `hooks/command-class.json`
    without taking the operator's choices with it, and `redlog class` never
    edits a file the next install will overwrite. `home=None` compiles with
    neither.
    """
    if home is None:
        return build_policy(read_shipped(), None)
    return build_policy(read_shipped(), read_overlay_file(home), read_contributed_file(home))


def build_policy(shipped, overlay, contributed=None):
    """What classify_argv reads. Never the raw file: the shipped native and
    pty lists no longer hold every default, because tool profiles name the
    rest, and only compile_policy puts them together."""
    policy = {
        "repl": shipped.get("repl", []),
        "replScriptFlags": shipped.get("replScriptFlags", []),
        "wrappers": shipped.get("wrappers", {}),
    }
    policy.update(compile_policy(overlay, shipped, contributed))
    return policy


MODES = ("native", "pty", "relayed")


def normalize_overlay(raw):
    """The operator's overlay as {relayed, pty, native: [str]} plus problems.

    Whatever else the file holds is ignored, the retired `removed` key
    included. A field that is not a list is ignored whole, a non-string item
    is dropped, and either one is recorded once for its field, in the order
    native, pty, relayed. Mirrored by normalizeOverlay in
    src/core/terminal-class.ts.
    """
    lists = {name: [] for name in CLASS_FIELDS}
    problems = []
    if not isinstance(raw, dict):
        return lists, problems
    for name in MODES:
        if name not in raw:
            continue
        value = raw[name]
        if not isinstance(value, list):
            problems.append({"kind": "invalid-overlay", "field": name})
            continue
        # A bare command name only, as an executable of a profile is: the zsh
        # adapter pastes `--field pty` into the source of a wrapper function.
        kept = [c for c in value if isinstance(c, str) and EXECUTABLE.fullmatch(c)]
        if len(kept) != len(value):
            problems.append({"kind": "invalid-overlay-names", "field": name})
        lists[name] = kept
    return lists, problems


def compile_policy(overlay, shipped, contributed=None):
    """Layer the policy: defaults, then tool profiles, then the operator's overlay.

    Returns {native, pty, entries, problems}. The highest layer that names a
    command decides its mode; a command no layer names is relayed. Two
    profiles that claim one executable in different modes cancel out, so the
    layer below keeps it and the clash is a problem for the operator to
    settle.

    `contributed` is the plugins' snapshot, as read_contributed_file returns it
    (`~/.redlog/terminal-profiles.json`): its profiles join the profile layer
    after the shipped ones, and its `held` map is the one thing that changes
    the rule above. When profiles disagree on a command and one is the
    recorded holder, the holder keeps it and the clash is still reported, with
    `kept` naming it. With no snapshot nothing holds anything and this is the
    layering above. Pure over its three arguments. Mirrored by
    compileClassPolicy in src/core/terminal-class.ts, and
    test/command-class.test.ts runs both over the same cases, including list
    order.
    """
    layer = {}  # command -> (mode, source, profile id); insertion order is list order
    for command in shipped.get("native", []):
        layer[command] = ("native", "default", None)
    # After native, so a command in both lists is pty, as classify has it.
    for command in shipped.get("pty", []):
        layer[command] = ("pty", "default", None)

    snapshot_profiles, held, problems = normalize_contributed(contributed)
    claims = {}  # command -> [{profile, mode}], first claimant first
    # The plugins' profiles join after the shipped ones, so `#<index>` keeps counting.
    for index, profile in enumerate(list(shipped.get("terminalProfiles", [])) + snapshot_profiles):
        if not valid_profile(profile):
            # Named by its id only when that is safe to print: it comes out of a file.
            ident = profile["id"] if isinstance(profile, dict) and valid_id(profile.get("id")) else "#%d" % index
            problems.append({"kind": "invalid-profile", "profile": ident})
            continue
        for command in profile["executables"]:
            claimed = claims.setdefault(command, [])
            if not any(c["profile"] == profile["id"] for c in claimed):
                claimed.append({"profile": profile["id"], "mode": profile["mode"]})
    conflicts = []
    for command, claimed in claims.items():
        # The profile that had this command when the snapshot was written, if
        # it still claims it. With no snapshot nothing holds anything.
        holding = next((c for c in claimed if c["profile"] == held.get(command)), None)
        if len({c["mode"] for c in claimed}) == 1:
            winner = holding or claimed[0]
            layer[command] = (winner["mode"], "profile", winner["profile"])
        elif holding is not None:
            # Disagreement over a command somebody already has: the holder
            # keeps it, and the clash is still reported.
            layer[command] = (holding["mode"], "profile", holding["profile"])
            conflicts.append({"kind": "conflict", "command": command, "claims": claimed, "kept": holding["profile"]})
        else:
            conflicts.append({"kind": "conflict", "command": command, "claims": claimed})
    problems += sorted(conflicts, key=lambda p: p["command"])

    overlay_lists, overlay_problems = normalize_overlay(overlay)
    problems += overlay_problems
    # Ascending, so a hand-edit naming one command twice resolves
    # pty over native over relayed.
    for mode in ("relayed", "native", "pty"):
        for command in overlay_lists[mode]:
            layer[command] = (mode, "override", None)

    entries = []
    for command in sorted(set(layer) | {p["command"] for p in problems if p["kind"] == "conflict"}):
        mode, source, profile = layer.get(command, ("relayed", "fallback", None))
        entry = {"command": command, "mode": mode, "source": source}
        if source == "profile":
            entry["profile"] = profile
        entries.append(entry)
    return {
        "native": [c for c, v in layer.items() if v[0] == "native"],
        "pty": [c for c, v in layer.items() if v[0] == "pty"],
        "entries": entries,
        "problems": problems,
    }


# A bare command name. A security bound, not tidiness: the adapter pastes each
# `pty` executable into the source of a wrapper function, so a name with a `;`,
# a space or a newline in it would be shell code. `fullmatch`, because `$`
# matches before a trailing newline here and `x\n` has to fail. Mirrored by
# EXECUTABLE in src/core/terminal-class.ts.
EXECUTABLE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._+-]{0,63}")


# A profile id: lowercase words, optionally `<plugin>/<id>`, at most 129
# characters. An id is printed by `redlog class list`, so what is not this shape
# is never shown, only counted by position. Mirrored by PROFILE_ID in
# src/core/terminal-class.ts. fullmatch, not `$`: Python's `$` also matches
# before a trailing newline.
PROFILE_ID = re.compile(r"[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)?")
PROFILE_ID_MAX = 129


def valid_id(ident):
    return isinstance(ident, str) and len(ident) <= PROFILE_ID_MAX and PROFILE_ID.fullmatch(ident) is not None


def valid_profile(profile):
    return (
        isinstance(profile, dict)
        and valid_id(profile.get("id"))
        and profile.get("mode") in MODES
        and isinstance(profile.get("executables"), list)
        and len(profile["executables"]) > 0
        and all(isinstance(c, str) and EXECUTABLE.fullmatch(c) for c in profile["executables"])
    )


def normalize_contributed(raw):
    """The plugins' snapshot as (profiles, held, problems).

    None is no file (and a file that says `null`): nothing, silently. Anything
    that is not a version-1 object with a list of profiles and an object of
    held is no snapshot at all, and one problem says why; a version above 1 is
    a file a newer RedLog wrote. A `held` value that is not a string is
    dropped, and each profile is passed through for valid_profile to judge.
    Mirrored by normalizeContributed in src/core/terminal-class.ts.
    """
    if raw is None:
        return [], {}, []
    unreadable = ([], {}, [{"kind": "invalid-snapshot", "reason": "unreadable"}])
    if not isinstance(raw, dict):
        return unreadable
    version = raw.get("version")
    number = not isinstance(version, bool) and isinstance(version, (int, float))
    if number and version > 1:
        return [], {}, [{"kind": "invalid-snapshot", "reason": "unsupported-version"}]
    if not number or version != 1:
        return unreadable
    if not isinstance(raw.get("profiles"), list) or not isinstance(raw.get("held"), dict):
        return unreadable
    held = {c: p for c, p in raw["held"].items() if isinstance(p, str)}
    return list(raw["profiles"]), held, []


def display_name(profile):
    """What a profile is called in a listing: its name when that is one plain
    line with no colon (a colon is how `native:` and `pty:` look like headers),
    else its id."""
    name = profile.get("name")
    if isinstance(name, str) and name and ":" not in name and plain_line(name):
        return name
    return profile["id"]


def plain_line(text):
    """True when text can be printed as one line: it encodes as UTF-8 (a lone
    surrogate does not, and writing one to stdout raises), and holds no C0, DEL
    or C1 control and no Unicode line or paragraph separator. The same rule as
    NOT_A_PLAIN_LINE in src/core/terminal-profiles.ts, which refuses such a name
    at registration; this covers a snapshot edited by hand."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return not any(ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F or ch in "\u2028\u2029" for ch in text)


def policy_notes(bundled, contributed, policy):
    """The lines `redlog class list` prints after the three class lines.

    `bundled` and `contributed` are the profiles of the shipped file and of the
    plugins' snapshot, as parsed. None of the lines may contain `native:`,
    `pty:` or `relayed:`: the tests, and anyone grepping the listing, take
    those as the headers.
    """
    entries = {e["command"]: e for e in policy["entries"]}

    def usable(profiles):
        return [p for p in profiles if isinstance(p, dict) and isinstance(p.get("id"), str)]

    bundled = usable(bundled)
    contributed = usable(contributed)
    names = {}
    for p in bundled + contributed:
        names.setdefault(p["id"], display_name(p))
    # A plugin's profile is named with the plugin it came from, which is its
    # id's prefix. A bundled one is just its name.
    plugins = {}
    for p in contributed:
        if p["id"] not in {b["id"] for b in bundled}:
            plugins.setdefault(p["id"], p["id"].split("/", 1)[0] if "/" in p["id"] else None)

    def label(ident):
        origin = plugins.get(ident)
        return names.get(ident, ident) if origin is None else "%s from %s" % (names[ident], origin)

    def owned_by(p):
        listed = [c for c in (p.get("executables") if isinstance(p.get("executables"), list) else []) if isinstance(c, str)]
        return [c for c in dict.fromkeys(listed)
                if c in entries and entries[c]["source"] == "profile" and entries[c].get("profile") == p["id"]]

    lines = []
    for heading, group in (("tool profiles", bundled), ("plugin profiles", contributed)):
        shown = []
        for p in group:
            owned = owned_by(p)
            if owned:
                shown.append("%s (%s)" % (label(p["id"]), " ".join(owned)))
        if shown:
            lines.append("%s: %s" % (heading, ", ".join(shown)))
    changes = ["%s (%s)" % (e["command"], e["mode"]) for e in policy["entries"] if e["source"] == "override"]
    if changes:
        lines.append("your changes: " + ", ".join(changes))

    def joined(said):
        return said[0] if len(said) == 1 else ", ".join(said[:-1]) + " and " + said[-1]

    for problem in policy["problems"]:
        if problem["kind"] != "conflict" or entries[problem["command"]]["source"] == "override":
            continue
        command = problem["command"]
        kept = problem.get("kept")
        if kept is None:
            said = ["%s (%s)" % (label(c["profile"]), c["mode"]) for c in problem["claims"]]
            lines.append("%s stays %s because profiles %s disagree; choose one with: redlog class add <class> %s"
                         % (command, entries[command]["mode"], joined(said), command))
        else:
            others = ["%s (%s)" % (label(c["profile"]), c["mode"]) for c in problem["claims"] if c["profile"] != kept]
            # No "from" here: label() already says it for a plugin's profile.
            # And no colon after the class, which is how a header looks.
            lines.append("%s stays %s because %s had it first; %s %s not applied; choose one with: redlog class add <class> %s"
                         % (command, entries[command]["mode"], label(kept), joined(others),
                            "is" if len(others) == 1 else "are", command))
    for problem in policy["problems"]:
        # The two are different faults, and the operator fixes them differently:
        # a field that is no list is ignored whole; in a list, only the entries
        # that are not command names are.
        if problem["kind"] == "invalid-overlay":
            lines.append("ignored in ~/.redlog/command-class.json: %s is not a list of commands" % problem["field"])
        elif problem["kind"] == "invalid-overlay-names":
            lines.append("ignored in ~/.redlog/command-class.json: %s lists something that is not a command name"
                         % problem["field"])
    for problem in policy["problems"]:
        if problem["kind"] == "invalid-snapshot":
            why = "written by a newer RedLog" if problem["reason"] == "unsupported-version" else "not readable"
            lines.append("ignored ~/.redlog/terminal-profiles.json: %s, so no plugin profile applies" % why)
    for problem in policy["problems"]:
        if problem["kind"] == "invalid-profile":
            lines.append("skipped tool profile %s: not valid" % problem["profile"])
    return lines


def basename(token):
    return token.rsplit("/", 1)[-1]


def int_or(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


# ── Tool detection (#499 PR B) ──────────────────────────────────────────────
#
# Which of the tool profiles' executables this shell can reach. RedLog cannot
# know the PATH a shell's commands resolve against — the rc files that set it
# run after the hook is sourced — so the shell says, once, at its first prompt.
# It is information for a settings panel and nothing else: it is never read by
# `classify`, `policy`, `finish` or `pty`, and a name that is not found changes
# no command's class.

DETECT_MAX_EXECUTABLES = 64
DETECT_DEADLINE_S = 2.0


class DetectDeadline(Exception):
    """The lookup ran out of time. Names it had not reached are unchecked, not missing."""


def profile_executables(profiles):
    """The bare executable names of the profiles `compile_policy` would accept,
    sorted, unique and no more than a report may hold. `profiles` is the shipped
    ones and then the plugins', in the order the compiler reads them (the seam
    `knownProfiles` is in src/core/terminal-class.ts)."""
    names = set()
    for profile in profiles:
        if valid_profile(profile):
            names.update(c for c in profile["executables"] if re.fullmatch(r"[A-Za-z0-9._+-]+", c))
    return sorted(names)[:DETECT_MAX_EXECUTABLES]


def path_dirs(path_value):
    """Absolute PATH entries, in order, once each. A relative entry means
    something different in every process that reads it."""
    seen = set()
    dirs = []
    for entry in path_value.split(os.pathsep):
        if entry and os.path.isabs(entry) and entry not in seen:
            seen.add(entry)
            dirs.append(entry)
    return dirs


def find_executable(name, dirs, windows, pathext, deadline):
    """Where `name` is, or None. POSIX wants a regular file with the execute
    bit; Windows has no such bit, so the bare name and then each PATHEXT
    spelling are tried, as src/core/command-lookup.ts does. `deadline` is a
    time.monotonic() value, checked before every stat."""
    names = [name] + [name + ext for ext in pathext] if windows else [name]
    for directory in dirs:
        for candidate in names:
            if time.monotonic() > deadline:
                raise DetectDeadline()
            path = os.path.join(directory, candidate)
            try:
                if os.path.isfile(path) and (windows or os.access(path, os.X_OK)):
                    return path
            except OSError:
                continue
    return None


def detect_cmd(argv):
    opts = parse(argv)[0]
    started = time.monotonic()
    deadline = started + DETECT_DEADLINE_S
    try:
        shipped = read_shipped()
        contributed = normalize_contributed(read_contributed_file(terminal_home(opts)))[0]
        names = profile_executables(list(shipped.get("terminalProfiles", [])) + list(contributed))
    except (OSError, ValueError):
        return 0
    windows = sys.platform == "win32"
    pathext = [e for e in os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";") if e]
    dirs = path_dirs(os.environ.get("PATH", ""))
    checked = []
    found = {}
    try:
        for name in names:
            where = find_executable(name, dirs, windows, pathext, deadline)
            checked.append(name)
            if where:
                found[name] = where
    except DetectDeadline:
        pass
    shell = opts["shell"] if opts["shell"] and re.fullmatch(r"[A-Za-z0-9._-]{1,32}", opts["shell"]) else "unknown"
    distro = (os.environ.get("WSL_DISTRO_NAME") or "")[:128]
    # The id is what RedLog reads back and matches against `^shell:[A-Za-z0-9._:-]{1,160}$`;
    # the distro as WSL spells it stays in `wslDistro`.
    distro_id = re.sub(r"[^A-Za-z0-9._-]", "_", distro[:64])
    environment = "shell:%s:%s:%s" % (sys.platform, distro_id or "-", shell)
    report = {
        "version": 1,
        "environment": environment,
        "platform": sys.platform,
        "shell": shell,
        "sessionId": opts["session"] or "",
        "detectedAt": int(time.time() * 1000),
        "checked": checked,
        "found": found,
    }
    if distro:
        report["wslDistro"] = distro
    file_name = re.sub(r"[^A-Za-z0-9._-]", "_", environment) + ".json"
    write_detection(os.path.join(terminal_home(opts), ".redlog", "tool-detection", file_name), report)
    trace("detect", "checked=%d found=%d ms=%d" % (len(checked), len(found), (time.monotonic() - started) * 1000))
    return 0


def write_detection(path, payload):
    """One writer per file name at a time is not guaranteed — two shells of one
    kind can open together — so the temporary name is this process's own, and
    the last `os.replace` wins whole."""
    tmp = "%s.%d.part" % (path, os.getpid())
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


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
    modes = {"run": run, "pty": pty_pipe, "finish": finish,
             "classify": classify, "policy": policy_field,
             "state": state_cmd, "detect": detect_cmd}
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
