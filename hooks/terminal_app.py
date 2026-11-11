"""Terminal selection from OS-observed process ancestry, never environment hints."""
import os
import plistlib
import subprocess
import sys
from pathlib import Path

_APPS = {
    'dev.warp.Warp-Stable': 'WarpTerminal',
    'com.apple.Terminal': 'Apple_Terminal',
    'com.googlecode.iterm2': 'iTerm.app',
    'com.microsoft.VSCode': 'vscode',
    'com.redlog.app': 'builtin',
}
_BOUNDARIES = {'tmux', 'screen', 'ssh', 'sshd', 'wsl', 'wsl.exe'}


def _process_table():
    # comm is the executable, not argv: unrelated process command lines may
    # contain secrets. One bounded observation avoids a subprocess per ancestor.
    result = subprocess.run(
        ['/bin/ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='],
        capture_output=True, text=True, timeout=0.75, check=True)
    if len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError('process observation too large')
    processes = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 7)
        if len(fields) == 8 and fields[0].isdigit() and fields[1].isdigit():
            processes[int(fields[0])] = (int(fields[1]), ' '.join(fields[2:7]), fields[7])
    return processes


def _bundle(executable):
    actual = Path(executable)
    if not actual.is_absolute():
        return None
    # The outer app owns its nested helper bundles. A helper may lead to its
    # main process; an unrelated GUI app is a boundary, not a path to Warp.
    app = next((parent for parent in reversed(actual.parents) if parent.suffix == '.app'), None)
    if app is None:
        return None
    with (app / 'Contents' / 'Info.plist').open('rb') as file:
        info = plistlib.load(file)
    kind = _APPS.get(info.get('CFBundleIdentifier'))
    main = app / 'Contents' / 'MacOS' / str(info.get('CFBundleExecutable', ''))
    return kind, main.resolve() == actual.resolve()


def terminal_origin():
    if sys.platform != 'darwin':
        return None
    try:
        first = _process_table()
        own_pid = os.getpid()
        pid = own_pid
        visited = {}
        for _ in range(32):
            if pid in visited or pid not in first:
                return None
            record = first[pid]
            visited[pid] = record
            parent, born, executable = record
            if not born or Path(executable).name in _BOUNDARIES:
                return None
            # A framework Python interpreter is itself packaged as Python.app.
            # It is this verifier, not the terminal host; do not attest/reject
            # its own bundle as the originating GUI application.
            bundle = _bundle(executable) if pid != own_pid else None
            if bundle:
                kind, is_main = bundle
                if kind is None:
                    return None
                if is_main:
                    # Re-observe the entire lineage so PID reuse/reparenting
                    # during lookup cannot attest another process's origin.
                    second = _process_table()
                    if any(second.get(key) != value for key, value in visited.items()):
                        return None
                    return kind
            pid = parent
    except (OSError, ValueError, TypeError, plistlib.InvalidFileException, subprocess.SubprocessError):
        return None
    return None


SELECTIONS = ('WarpTerminal', 'Apple_Terminal', 'iTerm.app', 'vscode', 'WindowsTerminal')


def selections_for(origin):
    """The restricted selections a terminal of this origin satisfies."""
    if origin == 'builtin':
        return list(SELECTIONS)
    return [origin] if origin in SELECTIONS else []


def terminal_app_allowed(directory=None):
    root = Path(directory or os.environ.get('_REDLOG_DIR') or Path.home() / '.redlog')
    try:
        wanted = (root / 'terminal-app').read_text().strip()
    except FileNotFoundError:
        return True
    except (OSError, UnicodeError):
        return False
    if wanted == 'all':
        return True
    if wanted not in SELECTIONS:
        return False
    return wanted in selections_for(terminal_origin())


def main(argv):
    # `--allows`: the selections this terminal satisfies, space-separated. The
    # shell adapters ask once and keep the answer for the life of the shell —
    # the origin does not change while it runs, and observing it costs a `ps`
    # — then compare each command's selection against it.
    if argv[:1] == ['--allows']:
        sys.stdout.write(' '.join(selections_for(terminal_origin())))
        return 0
    return 0 if terminal_app_allowed(argv[0] if argv else None) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
