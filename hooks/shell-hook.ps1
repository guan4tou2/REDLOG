# RedLog PowerShell Shell Hook
# Captures every command executed in PowerShell and sends to RedLog.
# Works with PowerShell 5.1+ and PowerShell 7+ (pwsh).
#
# Usage — add to your $PROFILE:
#   . "C:\path\to\redlog\hooks\shell-hook.ps1"

$script:_RedLogPortFile = Join-Path $env:USERPROFILE '.redlog\api-port'
$script:_RedLogTokenFile = Join-Path $env:USERPROFILE '.redlog\api-token'
$script:_RedLogLastId = 0
$script:_RedLogCmdStart = $null

function _RedLogIsRunning {
    (Test-Path $script:_RedLogPortFile) -and (Test-Path $script:_RedLogTokenFile)
}

function _RedLogSendEvent {
    param(
        [string]$Subtype,
        [string]$Command,
        [hashtable]$Extra = @{}
    )
    if (-not (_RedLogIsRunning)) { return }

    try {
        $port = Get-Content $script:_RedLogPortFile -Raw
        $token = Get-Content $script:_RedLogTokenFile -Raw
        $port = $port.Trim()
        $token = $token.Trim()

        $data = @{
            subtype = $Subtype
            command = $Command
            shell   = 'powershell'
            pid     = $PID
        }
        if ($env:REDLOG_TERMINAL -eq '1') {
            $data['source'] = 'builtin-terminal'
        }
        if ($env:REDLOG_TERMINAL_ID) {
            $data['terminalId'] = $env:REDLOG_TERMINAL_ID
        }
        foreach ($k in $Extra.Keys) { $data[$k] = $Extra[$k] }

        $body = @{ agent_type = 'shell'; data = $data } | ConvertTo-Json -Depth 4 -Compress
        $uri = "http://127.0.0.1:${port}/api/events"
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type'  = 'application/json'
        }

        # Fire-and-forget: use a runspace so the prompt is not blocked
        $rs = [runspacefactory]::CreateRunspace()
        $rs.Open()
        $ps = [powershell]::Create().AddScript({
            param($uri, $headers, $body)
            try {
                Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -TimeoutSec 2 | Out-Null
            } catch {}
        }).AddArgument($uri).AddArgument($headers).AddArgument($body)
        $ps.Runspace = $rs
        $null = $ps.BeginInvoke()
    } catch {}
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

Write-Host '[redlog] PowerShell hook active - commands will be logged to RedLog timeline' -ForegroundColor DarkGray
