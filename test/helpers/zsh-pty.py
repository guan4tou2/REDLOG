#!/usr/bin/env python3
"""Drive a real interactive zsh on a pty, one command at a time.

Spec 052's adapter is built on zsh's `preexec`/`precmd`. Neither fires under
`zsh -c`, and a piped stdout hides the line discipline that the relay has to
leave intact — so the only honest way to test it is a pty with an interactive
shell on the far end.

Node could do this with `node-pty`, a native module this repository already
fights with (`electron-rebuild -w` fails on it). Python's `pty` is standard
library, and Kali — the delivery target — ships Python 3. So the driver lives
here and the TypeScript side shells out to it.

Protocol: a JSON job on stdin, a JSON report on stdout. Nothing else is printed
to stdout, so a crash is distinguishable from a result.

  {"home": "/tmp/h", "zdotdir": "/tmp/h", "commands": ["whoami"],
   "timeout_s": 15, "settle_s": 0.25}

  {"ok": true, "steps": [{"command": "whoami", "output": "root"}],
   "exit_code": 0, "transcript": "..."}

Synchronisation is by prompt, not by sleeping: the shell is given a unique
PS1, and each command is considered finished when that marker comes back.
A sleep long enough to be safe on a loaded machine is long enough to make the
suite unusable, and a sleep short enough to be usable is a flake.
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import time
import uuid

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[=>\]].*?(?:\x07|\x1b\\)?|\x1b[=>]|\r")


def strip_ansi(text):
    return ANSI.sub("", text)


class Session:
    def __init__(self, job):
        self.marker = "RLPTY-" + uuid.uuid4().hex[:12]
        self.job = job
        self.timeout = float(job.get("timeout_s", 15))
        self.settle = float(job.get("settle_s", 0.25))
        self.buffer = ""
        self.transcript = []

    def make_home(self):
        """The throwaway HOME is created HERE, on the shell's own filesystem.

        It used to be made by the caller and handed over as a path. On Windows
        that meant `/mnt/c/...`, and every read the shell and the adapter do —
        the rc, `.redlog`, zsh's compdump, the adapter's spool — crossed the
        9p mount. One command took over thirty seconds that way and six when
        the same HOME was local, which reads as a hung adapter rather than as
        a slow filesystem.
        """
        home = tempfile.mkdtemp(prefix="redlog-zsh-")
        with open(os.path.join(home, ".zshrc"), "w") as fh:
            # PROMPT_SP makes zsh print a reverse-video `%` and a line of
            # spaces whenever the previous output did not end with a newline,
            # so the terminal shows where the output stopped. It is a feature
            # for a human and noise for an assertion — a test comparing a
            # one-word file's contents reads `auto\n%` and fails on the
            # prompt's politeness rather than on anything the product did.
            fh.write("unsetopt PROMPT_SP 2>/dev/null\n")
            fh.write(self.job.get("rc", "") + "\n")
        redlog = self.job.get("redlog")
        if redlog:
            d = os.path.join(home, ".redlog")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "api-port"), "w") as fh:
                fh.write(str(redlog["port"]))
            with open(os.path.join(d, "api-token"), "w") as fh:
                fh.write(str(redlog["token"]))
            # `hooks/redlog-session.py` reads this at session start and
            # refuses without it — identity is pinned when the PTY recorder
            # opens, not when an event is sent (spec 022). Only written when
            # the job asks, so the jobs that do not exercise the recorder see
            # the same payloads they always did.
            identity = redlog.get("identity")
            if identity:
                with open(os.path.join(d, "active-identity.json"), "w") as fh:
                    json.dump(identity, fh)
        return home

    def start(self):
        env = dict(os.environ)
        env.update(self.job.get("env", {}))
        home = self.home = self.make_home()
        env["HOME"] = home
        env["ZDOTDIR"] = self.job.get("zdotdir", home)
        env["TERM"] = "xterm-256color"
        env["PROMPT"] = self.marker + " "
        env["PS1"] = self.marker + " "
        # No colour from the shell itself; the relay's own colour handling is
        # what the tests are about, not the prompt's.
        env.pop("ZSH_THEME", None)

        self.master, slave = pty.openpty()

        def become_session_leader_with_this_tty():
            # `setsid` alone starts a session with NO controlling terminal. The
            # shell then still reads and writes the pty, so every earlier test
            # worked — but the kernel only turns Ctrl-C / Ctrl-Z into SIGINT /
            # SIGTSTP for a session's controlling terminal, and zsh only does
            # job control on one. Without this, `^Z` is just a byte, `jobs` is
            # empty and `fg` has nothing to resume (spec 052 T044).
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        # `-d` (NO_GLOBAL_RCS): the distro's /etc/zsh/zshrc is not under test.
        # On Debian and Ubuntu it runs compinit, and on a CI runner whose
        # directories are group-writable compinit stops to ask "ignore
        # insecure directories? [y/n]" — so no prompt ever arrived and every
        # spec here failed as "no prompt after startup", on the first run that
        # had zsh installed at all. The rc under test is the one in ZDOTDIR.
        self.proc = subprocess.Popen(
            [self.job.get("shell", "/usr/bin/zsh"), "-d", "-i"],
            preexec_fn=become_session_leader_with_this_tty,
            stdin=slave, stdout=slave, stderr=slave,
            env=env, cwd=self.job.get("cwd", home),
        )
        os.close(slave)
        # The first prompt proves the shell is up and the rc has been read.
        self.read_until_marker(label="startup")

    def read_until_marker(self, label):
        deadline = time.time() + self.timeout
        while self.marker not in self.buffer:
            if time.time() > deadline:
                raise TimeoutError("no prompt after " + label)
            r, _, _ = select.select([self.master], [], [], 0.2)
            if not r:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                raise TimeoutError("pty closed during " + label)
            if not chunk:
                raise TimeoutError("pty EOF during " + label)
            text = chunk.decode("utf-8", "replace")
            self.buffer += text
            self.transcript.append(text)
        before, _, rest = self.buffer.partition(self.marker)
        self.buffer = rest
        return before

    def run(self, command):
        os.write(self.master, (command + "\n").encode("utf-8"))
        raw = self.read_until_marker(label=command)
        # Drain anything that arrives just after the prompt (a hook that writes
        # on precmd lands here), so the next command's output is not polluted.
        deadline = time.time() + self.settle
        while time.time() < deadline:
            r, _, _ = select.select([self.master], [], [], 0.05)
            if not r:
                continue
            chunk = os.read(self.master, 65536)
            if not chunk:
                break
            text = chunk.decode("utf-8", "replace")
            self.buffer += text
            self.transcript.append(text)
        clean = strip_ansi(raw)
        lines = [ln for ln in clean.split("\n")]
        # zsh echoes the command it was given; drop that first line only when
        # it is the echo, never a line of real output that happens to match.
        if lines and lines[0].strip().endswith(command.strip()):
            lines = lines[1:]
        return "\n".join(lines).strip("\n")

    # ── Steps that are not "type a line, wait for the prompt" ───────────────
    #
    # Spec 052 T044 is about a command that does NOT return to the prompt: a
    # listener holds the terminal until something connects, and the operator's
    # next keystroke is a control character, not a line. The string form of a
    # command cannot express either, so a command may also be a dict:
    #
    #   {"line": "nc -lvnp 4444", "until": "listening on"}
    #       type a line, then wait for TEXT instead of the prompt
    #   {"raw": "\u001a"}
    #       write bytes as they are — no newline — then wait for the prompt.
    #       `\u001a` is Ctrl-Z, delivered through the pty's own line
    #       discipline, so the kernel turns it into SIGTSTP exactly as a
    #       keyboard would.
    #   {"peer": {"port": 4444, "send": "hi\n", "hold": 0.5}}
    #       connect to a port from OUTSIDE the terminal — the other end of a
    #       reverse shell — send something, hold, hang up.
    #   {"prompt": true}
    #       wait for the prompt without sending anything
    #
    # A plain string is unchanged, so every existing suite is untouched.

    def read_until_text(self, needle, label, timeout=None):
        deadline = time.time() + (timeout or self.timeout)
        while needle not in self.buffer:
            if time.time() > deadline:
                raise TimeoutError("never saw %r during %s" % (needle, label))
            r, _, _ = select.select([self.master], [], [], 0.2)
            if not r:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                raise TimeoutError("pty closed during " + label)
            if not chunk:
                raise TimeoutError("pty EOF during " + label)
            text = chunk.decode("utf-8", "replace")
            self.buffer += text
            self.transcript.append(text)
        before, _, rest = self.buffer.partition(needle)
        self.buffer = rest
        return before + needle

    def step(self, spec):
        if "line" in spec:
            os.write(self.master, (spec["line"] + "\n").encode("utf-8"))
            out = self.read_until_text(spec["until"], spec["line"], spec.get("timeout"))
            return spec["line"], strip_ansi(out)
        if "raw" in spec:
            os.write(self.master, spec["raw"].encode("utf-8"))
            out = self.read_until_marker(label="raw " + repr(spec["raw"]))
            return "raw " + repr(spec["raw"]), strip_ansi(out)
        if "peer" in spec:
            peer = spec["peer"]
            sock = socket.create_connection((peer.get("host", "127.0.0.1"), peer["port"]), timeout=5)
            try:
                if peer.get("send"):
                    sock.sendall(peer["send"].encode("utf-8"))
                time.sleep(float(peer.get("hold", 0.3)))
            finally:
                sock.close()
            return "peer :%d" % peer["port"], ""
        if "sh" in spec:
            # A command run OUTSIDE the terminal, against the machine the shell
            # is on — for looking at what a stuck session looks like (`ps`)
            # rather than only at what the terminal printed.
            done = subprocess.run(["/bin/sh", "-c", spec["sh"]], capture_output=True, text=True, timeout=30)
            return "sh", (done.stdout + done.stderr)
        if spec.get("prompt"):
            return "prompt", strip_ansi(self.read_until_marker(label="prompt"))
        raise ValueError("unknown step: %r" % (spec,))

    def close(self):
        try:
            os.write(self.master, b"exit\n")
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            self.proc.wait(timeout=5)
        finally:
            try:
                os.close(self.master)
            except OSError:
                pass
            if getattr(self, "home", None) and not self.job.get("keep_home"):
                shutil.rmtree(self.home, ignore_errors=True)
        return self.proc.returncode


def main():
    job = json.load(sys.stdin)
    session = Session(job)
    report = {"ok": False, "steps": [], "marker": session.marker}
    session.home = None
    try:
        session.start()
        for command in job.get("commands", []):
            if isinstance(command, dict):
                label, output = session.step(command)
                report["steps"].append({"command": label, "output": output})
            else:
                started = time.time()
                output = session.run(command)
                report["steps"].append({
                    "command": command, "output": output,
                    # Per command, because the 100-command engagement (T045)
                    # is also the only place the cost of the relay shows up.
                    "ms": int((time.time() - started) * 1000),
                })
        report["ok"] = True
    except Exception as exc:  # reported, never raised: the caller wants the transcript
        report["error"] = "{}: {}".format(type(exc).__name__, exc)
    finally:
        try:
            report["exit_code"] = session.close()
        except Exception as exc:
            report["close_error"] = str(exc)
        report["transcript"] = strip_ansi("".join(session.transcript))
    json.dump(report, sys.stdout)


if __name__ == "__main__":
    main()
