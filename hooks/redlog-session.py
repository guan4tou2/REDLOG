#!/usr/bin/env python3
"""Explicit POSIX PTY capture. No input logging, global hooks, or private spool."""
import argparse
import codecs
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
    import pty
    import struct
    import termios
    import tty

    interactive = sys.stdin.isatty()
    saved = termios.tcgetattr(0) if interactive else None
    pid, master = pty.fork()
    if pid == 0:
        try:
            # The PTY owns capture for this shell. Profile-installed metadata
            # hooks must not re-read another project's credentials mid-session.
            os.environ['REDLOG_EXTERNAL_SESSION'] = '1'
            os.execvp(command[0], command)
        except OSError as error:
            os.write(2, f'[redlog] command could not start: {error}\n'.encode())
            os._exit(127)
    # Fork before starting the HTTP worker: forking an active urllib thread
    # can inherit locks held by a vanished thread on macOS.
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
    inputs = [master, 0]
    try:
        resize()
        if interactive:
            tty.setraw(0)
        while True:
            ready, _, _ = select.select(inputs, [], [])
            if master in ready:
                try:
                    data = os.read(master, 16384)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                recorder.output(decoder.decode(data))
            if 0 in ready:
                data = os.read(0, 16384)
                if data:
                    while data:
                        written = os.write(master, data)
                        data = data[written:]
                else:
                    inputs.remove(0)
        tail = decoder.decode(b'', final=True)
        if tail:
            recorder.output(tail)
    except BaseException:
        # Reap even when stdout closes or the launcher is interrupted. Kill
        # the PTY session group so a shell cannot leave its command behind.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        raise
    finally:
        if saved is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, saved)
        signal.signal(signal.SIGWINCH, old_resize)
        signal.signal(signal.SIGTERM, old_term)
        os.close(master)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def main():
    parser = argparse.ArgumentParser(description='Explicit PTY output capture for the active RedLog project')
    parser.add_argument('--max-bytes', type=int, default=50 * 1024 * 1024)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('use the PowerShell Start-Transcript integration on Windows')
    if args.max_bytes <= 0:
        parser.error('--max-bytes must be positive')
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
        return 1
    print('[redlog] session recording; merged output only, exit shell to finish', file=sys.stderr)
    try:
        code = run(command, recorder)
    except KeyboardInterrupt:
        code = 130
    except Exception as error:
        print(f'[redlog] terminal ended unexpectedly: {error}', file=sys.stderr)
        code = 1
    if recorder.thread.ident is not None:
        recorder.finish(code)
    else:
        recorder.send({'subtype': 'session_end', 'exitCode': code, 'incomplete': True})
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
