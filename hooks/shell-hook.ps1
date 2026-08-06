# RedLog PowerShell Shell Hook
# Captures every command executed in PowerShell and sends to RedLog.
# Works with PowerShell 5.1+ and PowerShell 7+ (pwsh).
#
# Usage — add to your $PROFILE:
#   . "C:\path\to\redlog\hooks\shell-hook.ps1"
#
# For STRUCTURED stdout/stderr capture (v0.6.94+), prefix a command with
# `Redlog-Run`, e.g.:
#   Redlog-Run nmap -sV target.com
# The default prompt hook only reports command metadata (exit code,
# duration) — PowerShell can't cleanly split stdout/stderr from a
# post-command hook. `Redlog-Run` runs the command with the two streams
# captured into separate files, truncated at 100 KB each, and sends them
# alongside the standard command_end event. Binary output renders as
# UTF-8 replacement characters.

$script:_RedLogDir       = Join-Path $env:USERPROFILE '.redlog'
$script:_RedLogPortFile  = Join-Path $script:_RedLogDir  'api-port'
$script:_RedLogTokenFile = Join-Path $script:_RedLogDir  'api-token'
$script:_RedLogSpoolDir  = Join-Path $script:_RedLogDir  'pending'
$script:_RedLogLastId    = 0
$script:_RedLogMaxBytes  = 102400   # 100 KB per stream (parity with bash hook)
$script:_RedLogSpoolCap  = 5000     # protects against a runaway loop while RedLog is offline

function _RedLogIsRunning {
    (Test-Path $script:_RedLogPortFile) -and (Test-Path $script:_RedLogTokenFile)
}

# Build a 19-digit padded timestamp (nanoseconds since Unix epoch, approximated
# from millisecond precision × 1e6) so spool filenames sort in creation order
# even when a bash-hook writer (`date +%s%N`) and a PowerShell writer land in
# the same ~/.redlog/pending/ directory. Main-process drain uses .sort() over
# the directory listing.
function _RedLogTimestamp {
    $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    ([int64]$ms * 1000000).ToString('D19')
}

# v0.6.94 A: spool the payload to disk when RedLog is unreachable so events
# don't silently vanish. Matches hooks/shell-preexec-hook.sh lines 105-127
# behaviour. main/index.ts:441-469 drains this directory on next project open
# (glob-matches *.json, agnostic to bash vs PowerShell writer).
function _RedLogSpoolPayload {
    param([string]$Json)
    try {
        if (-not (Test-Path $script:_RedLogSpoolDir)) {
            New-Item -ItemType Directory -Path $script:_RedLogSpoolDir -Force | Out-Null
        }
        # Cap the spool so a machine offline for weeks doesn't fill the disk.
        $count = @(Get-ChildItem -Path $script:_RedLogSpoolDir -Filter '*.json' -ErrorAction SilentlyContinue).Count
        if ($count -ge $script:_RedLogSpoolCap) { return }
        $name = "$(_RedLogTimestamp).$PID.json"
        $path = Join-Path $script:_RedLogSpoolDir $name
        # UTF-8 without BOM — the drain in main/index.ts uses JSON.parse which
        # rejects a leading BOM on some Node versions.
        [System.IO.File]::WriteAllText($path, $Json, [System.Text.UTF8Encoding]::new($false))
    } catch {
        # Best-effort. If the spool write fails, the event is lost — same
        # posture the bash hook takes.
    }
}

function _RedLogBuildPayload {
    param(
        [string]$Subtype,
        [string]$Command,
        [hashtable]$Extra = @{}
    )
    $data = @{
        subtype = $Subtype
        command = $Command
        shell   = 'powershell'
        pid     = $PID
    }
    if ($env:REDLOG_TERMINAL -eq '1') { $data['source'] = 'builtin-terminal' }
    if ($env:REDLOG_TERMINAL_ID)      { $data['terminalId'] = $env:REDLOG_TERMINAL_ID }
    foreach ($k in $Extra.Keys) { $data[$k] = $Extra[$k] }
    @{ agent_type = 'shell'; data = $data } | ConvertTo-Json -Depth 6 -Compress
}

function _RedLogSendEvent {
    param(
        [string]$Subtype,
        [string]$Command,
        [hashtable]$Extra = @{}
    )
    $body = _RedLogBuildPayload -Subtype $Subtype -Command $Command -Extra $Extra

    if (-not (_RedLogIsRunning)) {
        # No port/token → RedLog is closed. Spool for later drain.
        _RedLogSpoolPayload -Json $body
        return
    }

    try {
        $port  = (Get-Content $script:_RedLogPortFile  -Raw).Trim()
        $token = (Get-Content $script:_RedLogTokenFile -Raw).Trim()
        $uri     = "http://127.0.0.1:${port}/api/events"
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type'  = 'application/json'
        }
        # Foreground POST with short deadline — matches bash's curl 2s cap.
        # When RedLog IS listening this returns in ~10-50ms; the perceptible
        # cost only shows up when the port is stale, which is exactly the
        # case we want to spool for.
        Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 2 -ErrorAction Stop | Out-Null
    } catch {
        # POST failed (RedLog stopped, port stale, network hiccup) → spool.
        _RedLogSpoolPayload -Json $body
    }
}

# Save the original prompt so we can chain
if (-not $script:_RedLogOriginalPrompt) {
    $script:_RedLogOriginalPrompt = (Get-Item function:prompt).ScriptBlock
}

function prompt {
    $lastExit = $LASTEXITCODE
    $success = $?

    $entry = Get-History -Count 1 -ErrorAction SilentlyContinue
    if ($entry -and $entry.Id -ne $script:_RedLogLastId) {
        $cmd = $entry.CommandLine
        $duration = [int]($entry.EndExecutionTime - $entry.StartExecutionTime).TotalSeconds
        $exitCode = if ($success) { 0 } else { if ($lastExit) { $lastExit } else { 1 } }

        _RedLogSendEvent -Subtype 'command_start' -Command $cmd
        _RedLogSendEvent -Subtype 'command_end' -Command $cmd -Extra @{
            exit_code    = $exitCode
            duration_sec = $duration
        }
        $script:_RedLogLastId = $entry.Id
    }

    # Restore LASTEXITCODE so we don't pollute the user's session
    $global:LASTEXITCODE = $lastExit
    # Chain to the original prompt
    & $script:_RedLogOriginalPrompt
}

# v0.6.94 B: Opt-in structured capture wrapper — parity with the bash
# `redlog-run` function. Runs the given command with stdout and stderr
# captured into separate temp files (each truncated at 100 KB), emits
# command_start / command_end with structured stdout/stderr/*_bytes/
# *_truncated fields, and passes the output through to the terminal so
# nothing looks different from running the command bare.
#
# The normal prompt hook will ALSO fire for the Redlog-Run invocation
# itself. That's fine — the wrapper's command_end lands with the
# structured fields; the plain one just has metadata.
#
# Usage:
#   Redlog-Run nmap -sV target.com
#   Redlog-Run -Command 'Get-Process | Select-Object -First 5'
function Redlog-Run {
    # Deliberately NO [CmdletBinding()] + $Command parameter here — a user
    # invocation like `Redlog-Run nmap -sV target.com` would otherwise trigger
    # PowerShell's parameter binder on `-sV` and fail. Using $args means every
    # token after `Redlog-Run` reaches us verbatim, matching bash `redlog-run`.
    if ($args.Count -eq 0) {
        Write-Error 'Redlog-Run: expected a command'
        return
    }
    $Command = @($args)
    $cmdString = ($Command -join ' ')
    $startTs   = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

    # If RedLog isn't reachable we still run the command transparently — the
    # wrapper's hook is dormant, so a wrapper that fails would just annoy
    # the user. We DO still spool a metadata event via the standard path so
    # the timeline eventually shows the command.
    $stdoutFile = $null
    $stderrFile = $null
    try {
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $stderrFile = [System.IO.Path]::GetTempFileName()
    } catch {
        # tempfile failed — just run the command bare and let the prompt
        # hook pick it up.
        $exe0 = $Command[0]
        if ($Command.Count -gt 1) { & $exe0 @($Command[1..($Command.Count - 1)]) }
        else { & $exe0 }
        return
    }

    # Emit command_start so the timeline shows the row entering flight.
    _RedLogSendEvent -Subtype 'command_start' -Command $cmdString

    # Run the command with stream splitting. PowerShell doesn't have a clean
    # "run this argv with distinct stdout/stderr redirection" builtin the
    # way bash does — Start-Process with -RedirectStandardOutput/Error is
    # the closest match. It requires an executable path + args, so we use
    # Start-Process for external commands and fall back to an in-process
    # invocation with `2>&1 | Tee-Object` split-heuristic for cmdlets.
    $exitCode = 0
    $exe     = $Command[0]
    $exeArgs = if ($Command.Count -gt 1) { $Command[1..($Command.Count - 1)] } else { @() }

    # Detect whether $exe resolves to an external executable. Get-Command
    # returns an ApplicationInfo for external binaries, a CommandInfo of
    # other types for cmdlets/functions/aliases.
    $cmdInfo = Get-Command -Name $exe -ErrorAction SilentlyContinue
    $isExternal = $cmdInfo -and ($cmdInfo.CommandType -eq 'Application')

    try {
        if ($isExternal) {
            $sp = @{
                FilePath                = $cmdInfo.Path
                RedirectStandardOutput  = $stdoutFile
                RedirectStandardError   = $stderrFile
                NoNewWindow             = $true
                Wait                    = $true
                PassThru                = $true
            }
            if ($exeArgs.Count -gt 0) { $sp['ArgumentList'] = $exeArgs }
            $proc = Start-Process @sp
            $exitCode = $proc.ExitCode
        } else {
            # Cmdlet / function / alias — invoke in-process. PowerShell's own
            # streams don't map cleanly to two OS pipes, but redirecting the
            # error stream via `2>` and success via `>` gets close enough.
            & $exe @exeArgs 1>$stdoutFile 2>$stderrFile
            $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
        }
    } catch {
        $exitCode = 1
        # Best-effort — write the exception text into the stderr file so the
        # timeline reflects why the wrapper failed.
        try { Add-Content -Path $stderrFile -Value $_.Exception.Message } catch {}
    }

    $endTs    = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $duration = [int]($endTs - $startTs)

    # Read + truncate the captured streams. UTF-8 decode with replacement
    # fallback so invalid bytes (binary output like hexdump) do not throw.
    function _RedLogReadCapped {
        param([string]$Path, [int]$Cap)
        if (-not (Test-Path $Path)) { return @{ Text=''; Bytes=0; Truncated=$false } }
        $raw = [System.IO.File]::ReadAllBytes($Path)
        $bytes = $raw.Length
        $trunc = $bytes -gt $Cap
        if ($trunc) { $raw = $raw[0..($Cap - 1)] }
        $enc = [System.Text.Encoding]::UTF8   # default fallback = U+FFFD
        $text = $enc.GetString($raw)
        @{ Text=$text; Bytes=$bytes; Truncated=$trunc }
    }
    $so = _RedLogReadCapped -Path $stdoutFile -Cap $script:_RedLogMaxBytes
    $se = _RedLogReadCapped -Path $stderrFile -Cap $script:_RedLogMaxBytes

    # Pass output through to the terminal so the shell feels normal even if
    # the send is slow. Write-Host is intentional here (we want the visible
    # bytes, not a pipeline object).
    if ($so.Text.Length -gt 0) { Write-Host -NoNewline $so.Text }
    if ($se.Text.Length -gt 0) { [Console]::Error.Write($se.Text) }

    _RedLogSendEvent -Subtype 'command_end' -Command $cmdString -Extra @{
        exit_code        = $exitCode
        duration_sec     = $duration
        cwd              = (Get-Location).Path
        stdout           = $so.Text
        stderr           = $se.Text
        stdout_bytes     = $so.Bytes
        stderr_bytes     = $se.Bytes
        stdout_truncated = $so.Truncated
        stderr_truncated = $se.Truncated
        captured_by      = 'redlog-run'
    }

    try { Remove-Item -Path $stdoutFile -Force -ErrorAction SilentlyContinue } catch {}
    try { Remove-Item -Path $stderrFile -Force -ErrorAction SilentlyContinue } catch {}

    # Propagate exit code so callers can act on it.
    $global:LASTEXITCODE = $exitCode
}

Write-Host '[redlog] PowerShell hook active - commands will be logged to RedLog timeline' -ForegroundColor DarkGray
Write-Host '[redlog] tip: prefix a command with "Redlog-Run" for full stdout/stderr capture' -ForegroundColor DarkGray
