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
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
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
        self.proc = subprocess.Popen(
            [self.job.get("shell", "/usr/bin/zsh"), "-i"],
            preexec_fn=os.setsid,
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
            report["steps"].append({"command": command, "output": session.run(command)})
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
