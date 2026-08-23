# RedLog PowerShell Start-Transcript hook (docs/DESIGN-core-and-capture.md §2.3)
#
# The problem this solves: shell-hook.ps1 records a command, its exit code and
# duration automatically, but the OUTPUT only when the operator remembers to
# prefix with `Redlog-Run`. Remembering a prefix is note-taking discipline —
# the exact thing RedLog exists to remove — so on Windows the output was
# usually missing.
#
# Start-Transcript captures the full session (commands AND output) to a file
# with no per-command discipline. RedLog follows that file and parses it back
# into command events (src/core/start-transcript.ts). Same shape as the agent
# tailer: something else writes a file, RedLog reads it.
#
# Usage — add to your $PROFILE (alongside or instead of shell-hook.ps1):
#   . "C:\path\to\redlog\hooks\start-transcript-hook.ps1"
#
# It writes the transcript into ~/.redlog/transcripts/ where the tailer looks.
# One transcript per shell session, named by start time + PID so concurrent
# shells do not collide. Stopping the shell stops the transcript; a crash
# leaves a partial transcript the parser still reads (it tolerates a missing
# end banner).

$script:_RedLogTranscriptDir = Join-Path $env:USERPROFILE '.redlog\transcripts'

if (-not (Test-Path $script:_RedLogTranscriptDir)) {
    New-Item -ItemType Directory -Force -Path $script:_RedLogTranscriptDir | Out-Null
}

# Name: <unix-seconds>_<pid>.txt — the tailer keys on the filename to dedup and
# to order sessions, mirroring the .cast naming in terminal-manager.ts.
$script:_RedLogTs = [int][double]::Parse((Get-Date -UFormat %s))
$script:_RedLogTranscriptPath = Join-Path $script:_RedLogTranscriptDir "$($script:_RedLogTs)_$PID.txt"

try {
    # -IncludeInvocationHeader keeps each command's own `PS ...>` prompt line in
    # the file, which is exactly what the parser keys on. -Force overwrites the
    # (unique) path rather than erroring if it somehow exists.
    Start-Transcript -Path $script:_RedLogTranscriptPath -IncludeInvocationHeader -Force | Out-Null

    # Stop cleanly on exit so the end banner is written; the parser copes
    # without it, but a clean stop flushes the last command's output.
    Register-EngineEvent PowerShell.Exiting -Action {
        try { Stop-Transcript | Out-Null } catch { }
    } | Out-Null
}
catch {
    # Start-Transcript throws if a transcript is already running in this session
    # (nested profiles). That is fine — the existing one is already being
    # followed; do not fight it.
}
