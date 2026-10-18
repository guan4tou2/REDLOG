#!/usr/bin/env python3
"""Explicit POSIX PTY capture. No input logging, global hooks, or private spool."""
import argparse
import codecs
import datetime
import json
import os
import queue
import select
import signal
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

_TRACE_MAX_BYTES = 2 * 1024 * 1024


def _trace_target():
    """Where to write the trace, or None. Decided once per session.

    Settings > About > Debug log creates ~/.redlog/debug-enabled and the app
    writes ~/.redlog/debug.log beside it; this appends to the same file.
    REDLOG_SESSION_TRACE=<file> overrides both, for use without the app."""
    explicit = os.environ.get('REDLOG_SESSION_TRACE')
    if explicit:
        return explicit
    home = Path.home() / '.redlog'
    return str(home / 'debug.log') if (home / 'debug-enabled').exists() else None


_TRACE = _trace_target()


def trace(event, detail=''):
    """Timeline for diagnosing a lost-output report (#333 had none).

    Event names and byte counts only: what the command printed is never
    written, so the file is safe to attach to an issue. A write failure is
    ignored; tracing must never change what the command does."""
    if not _TRACE:
        return
    try:
        try:
            if os.path.getsize(_TRACE) > _TRACE_MAX_BYTES:
                os.replace(_TRACE, _TRACE + '.1')
        except OSError:
            pass
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp = now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'
        with open(_TRACE, 'a') as out:
            out.write(f'{stamp} session {event} {detail + " " if detail else ""}pid={os.getpid()}\n')
    except OSError:
        pass


class Recorder:
    def __init__(self, directory, max_bytes):
        self.identity = json.loads((directory / 'active-identity.json').read_text())
        self.engagement = self.identity['engagementId']
        self.token = (directory / 'api-token').read_text().strip()
        self.port = int((directory / 'api-port').read_text())
        self.url = f'http://127.0.0.1:{self.port}/api/events'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.session = str(uuid.uuid4())
        self.limit = max_bytes
        self.used = 0
        self.accepted = 0
        self.dropped = 0
        self.paused = 0
        self.truncated = False
        self.sequence = 0
        self.pending = queue.Queue(maxsize=64)
        self.thread = threading.Thread(target=self.drain, daemon=True)

    def send(self, data):
        payload = {'agent_type': 'shell', 'data': {
            'source': 'external-session', 'terminalId': self.session,
            'captured_by': 'redlog-session', **data}}
        req = urllib.request.Request(self.url, json.dumps(payload).encode(), {
            'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}',
            'X-Redlog-Engagement': self.engagement})
        try:
            with self.opener.open(req, timeout=1) as response:
                result = json.load(response)
            return 'paused' if result.get('recording') is False else 'accepted'
        except Exception:
            return 'failed'

    def start(self, command):
        status = self.send({'subtype': 'session_start', 'command': command,
                            'maxBytes': self.limit, 'stdout_stderr': 'merged',
                            'timestamp': int(time.time() * 1000)})
        if status != 'accepted':
            raise RuntimeError('capture is paused or unavailable; resume recording in the intended project first')

    def output(self, text):
        size = len(text.encode('utf8'))
        if self.truncated or self.used + size > self.limit:
            if not self.truncated:
                print('\r\n[redlog] capture size limit reached; terminal remains live', file=sys.stderr)
            self.truncated = True
            self.dropped += size
            return
        self.used += size
        self.sequence += 1
        try:
            self.pending.put_nowait({'subtype': 'session_output', 'stdout': text,
                                    'sequence': self.sequence, 'timestamp': int(time.time() * 1000)})
        except queue.Full:
            if self.dropped == 0:
                print('\r\n[redlog] capture queue full; output is being omitted', file=sys.stderr)
            self.dropped += size

    def drain(self):
        while True:
            data = self.pending.get()
            if data is None:
                return
            # Never replay dropped or paused bytes into another interval.
            status = self.send(data)
            size = len(data.get('stdout', '').encode('utf8'))
            if status == 'failed':
                if self.dropped == 0:
                    print('\r\n[redlog] capture unavailable; output is being omitted', file=sys.stderr)
                self.dropped += size
            elif status == 'paused':
                self.paused += size
            else:
                self.accepted += size

    def finish(self, code):
        # A stalled API must not hold the user's terminal hostage.
        try:
            self.pending.put(None, timeout=1)
        except queue.Full:
            print('[redlog] recorder queue did not drain; session end is incomplete', file=sys.stderr)
            return
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            print('[redlog] recorder still unavailable; session end is incomplete', file=sys.stderr)
            return
        status = self.send({'subtype': 'session_end', 'exitCode': code,
                            'outputBytes': self.accepted, 'omittedBytes': self.dropped,
                            'pausedBytes': self.paused, 'truncated': self.truncated,
                            'timestamp': int(time.time() * 1000)})
        if status != 'accepted':
            print('[redlog] session end was not recorded (paused, disconnected, or project changed)', file=sys.stderr)
        if self.dropped or self.paused:
            print(f'[redlog] omitted {self.dropped} bytes; skipped {self.paused} bytes while paused', file=sys.stderr)


def run(command, recorder):
    import errno
    import fcntl
    import struct
    import termios
    import tty

    interactive = sys.stdin.isatty()
    saved = termios.tcgetattr(0) if interactive else None
    # Read the size before forking: the child sets it on its own terminal
    # before exec, so a command that starts at once (stty, a TUI) never sees
    # the 0x0 of a PTY the parent has not sized yet.
    initial_size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8) if interactive else struct.pack('HHHH', 24, 80, 0, 0)
    # pty.fork() hands the parent only the master. A short command can then
    # exit before the first read, and macOS discards whatever the master has
    # not read once the last slave descriptor closes: exit 0, no output, no
    # error (#333; ~1% of runs under CPU load, 0 of 800 when the slave is
    # held). Open the pair ourselves and keep the slave until the master has
    # been drained.
    master, slave = os.openpty()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, initial_size)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            # The PTY owns capture for this shell. Profile-installed metadata
            # hooks must not re-read another project's credentials mid-session.
            os.environ['REDLOG_EXTERNAL_SESSION'] = '1'
            os.execvp(command[0], command)
        except OSError as error:
            os.write(2, f'[redlog] command could not start: {error}\n'.encode())
            os._exit(127)
    # Fork before starting the HTTP worker: forking an active urllib thread
    # can inherit locks held by a vanished thread on macOS.
    trace('forked', f'child={pid} interactive={interactive}')
    recorder.thread.start()
    decoder = codecs.getincrementaldecoder('utf8')('replace')

    def resize(*_):
        if interactive:
            size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
        else:
            size = struct.pack('HHHH', 24, 80, 0, 0)
        fcntl.ioctl(master, termios.TIOCSWINSZ, size)

    old_resize = signal.signal(signal.SIGWINCH, resize)
    old_term = signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
    def forward(data):
        trace('output', f'bytes={len(data)}')
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        recorder.output(decoder.decode(data))

    inputs = [master, 0]
    child_status = None
    slave_open = True
    try:
        resize()
        if interactive:
            tty.setraw(0)
        while True:
            # Holding the slave means the master reports no EOF for the child,
            # so wake briefly to notice it has exited. Once the slave is
            # closed, EOF means every other holder (a background job) is gone.
            ready, _, _ = select.select(inputs, [], [], 0.02 if slave_open else None)
            if master in ready:
                try:
                    data = os.read(master, 16384)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b''
                    else:
                        raise
                if not data:
                    # EOF/EIO describes this PTY read, not the child's exit.
                    # While we hold the slave it cannot be a real hang-up, so
                    # keep going; after it is closed (child reaped), EOF means
                    # every other holder has gone.
                    trace('master-eof', f'slave_open={slave_open}')
                    if slave_open:
                        time.sleep(0.01)
                    else:
                        break
                else:
                    forward(data)
            if 0 in ready:
                data = os.read(0, 16384)
                if data:
                    while data:
                        written = os.write(master, data)
                        data = data[written:]
                else:
                    inputs.remove(0)
            if slave_open:
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended:
                    child_status = status
                    trace('child-reaped', f'status={status}')
                    # Everything the child wrote is already queued on the
                    # master; take it before the slave goes away.
                    while select.select([master], [], [], 0)[0]:
                        try:
                            data = os.read(master, 16384)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        if not data:
                            break
                        forward(data)
                    os.close(slave)
                    slave_open = False
                    trace('slave-closed')
        trace('loop-exit')
        tail = decoder.decode(b'', final=True)
        if tail:
            recorder.output(tail)
    except BaseException as error:
        trace('aborted', type(error).__name__)
        # Reap even when stdout closes or the launcher is interrupted. Kill
        # the PTY session group so a shell cannot leave its command behind.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if child_status is None:
            os.waitpid(pid, 0)
        raise
    finally:
        if saved is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, saved)
        signal.signal(signal.SIGWINCH, old_resize)
        signal.signal(signal.SIGTERM, old_term)
        if slave_open:
            os.close(slave)
        os.close(master)
    if child_status is None:
        _, child_status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(child_status)


def run_unrecorded(command):
    """Become the command. Nothing of this process survives to confuse the
    caller's `$?` — the operator's exit status is the command's own."""
    try:
        os.execvp(command[0], command)
    except FileNotFoundError:
        print(f'[redlog] {command[0]}: command not found', file=sys.stderr)
        return 127
    except OSError as error:
        print(f'[redlog] {command[0]}: {error.strerror or error}', file=sys.stderr)
        return 126
    return 126  # execvp does not return


def main():
    parser = argparse.ArgumentParser(description='Explicit PTY output capture for the active RedLog project')
    parser.add_argument('--max-bytes', type=int, default=50 * 1024 * 1024)
    parser.add_argument('--nested', action='store_true',
                        help='record even inside another redlog-session (e.g. a tmux server that outlived it)')
    parser.add_argument('--best-effort', action='store_true',
                        help='if the recorder cannot start, run the command anyway, unrecorded')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('use the PowerShell Start-Transcript integration on Windows')
    if args.max_bytes <= 0:
        parser.error('--max-bytes must be positive')
    # #218: a session inside a session records the same bytes twice — the
    # outer PTY already sees everything drawn here, tmux panes included. Start
    # one recorder per terminal, at the outermost layer you want recorded.
    if os.environ.get('REDLOG_EXTERNAL_SESSION') == '1' and not args.nested:
        print('[redlog] already inside a redlog-session: this terminal is being recorded. '
              'Not starting a second recorder (use --nested if the outer session has ended, '
              'e.g. in a tmux server started from it).', file=sys.stderr)
        # Under the automatic wrapper this is the common case, not an error:
        # the outer PTY already sees everything this command draws, so the
        # right thing is to run it and record nothing twice.
        if args.best_effort and args.command:
            command = args.command[1:] if args.command[:1] == ['--'] else args.command
            return run_unrecorded(command)
        return 2
    command = args.command
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        if not sys.stdin.isatty():
            parser.error('interactive shell requires a terminal; otherwise specify a command')
        command = [os.environ.get('SHELL', '/bin/bash')]
    try:
        recorder = Recorder(Path.home() / '.redlog', args.max_bytes)
        recorder.start(' '.join(command))
    except Exception as error:
        print(f'[redlog] session not started: {error}', file=sys.stderr)
        # Type only: the message can carry a path under the operator's home.
        trace('not-started', f'error={type(error).__name__} best_effort={args.best_effort}')
        # Spec 052: the adapter wraps `ssh` and the other PTY-class programs
        # automatically, so this path is now reached by a command the operator
        # typed for their own reasons rather than by someone asking to record.
        # Refusing to run their `ssh` because recording is paused would be a
        # logger deciding what the engagement may do; the command runs, and
        # the adapter's own `command_end` already says no body was held.
        if args.best_effort:
            return run_unrecorded(command)
        return 1
    print('[redlog] session recording; merged output only, exit shell to finish', file=sys.stderr)
    try:
        code = run(command, recorder)
    except KeyboardInterrupt:
        code = 130
    except Exception as error:
        print(f'[redlog] terminal ended unexpectedly: {error}', file=sys.stderr)
        trace('ended-unexpectedly', f'error={type(error).__name__}')
        code = 1
    if recorder.thread.ident is not None:
        recorder.finish(code)
    else:
        recorder.send({'subtype': 'session_end', 'exitCode': code, 'incomplete': True})
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
