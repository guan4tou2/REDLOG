# RedLog Event Sender for PowerShell
# Fire-and-forget event posting from any PowerShell script or tool.
#
# Usage:
#   . .\hooks\redlog-send.ps1
#   Send-RedLogEvent "nmap -sV 10.0.0.1" command_start
#   nmap -sV 10.0.0.1
#   Send-RedLogEvent "nmap -sV 10.0.0.1" command_end @{ exit_code = $LASTEXITCODE }

$script:_RedLogPortFile = Join-Path $env:USERPROFILE '.redlog\api-port'
$script:_RedLogTokenFile = Join-Path $env:USERPROFILE '.redlog\api-token'

function Send-RedLogEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$Command,

        [Parameter(Mandatory, Position = 1)]
        [ValidateSet('command_start', 'command_end', 'note', 'marker')]
        [string]$Subtype,

        [Parameter(Position = 2)]
        [hashtable]$Extra = @{}
    )

    if (-not (Test-Path $script:_RedLogPortFile) -or
        -not (Test-Path $script:_RedLogTokenFile)) {
        return
    }

    try {
        $port = (Get-Content $script:_RedLogPortFile -Raw).Trim()
        $token = (Get-Content $script:_RedLogTokenFile -Raw).Trim()

        $data = @{
            subtype = $Subtype
            command = $Command
            shell   = 'powershell'
            pid     = $PID
        }
        foreach ($k in $Extra.Keys) { $data[$k] = $Extra[$k] }

        $body = @{ agent_type = 'shell'; data = $data } | ConvertTo-Json -Depth 4 -Compress
        $uri = "http://127.0.0.1:${port}/api/events"
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type'  = 'application/json'
        }

        # Fire-and-forget via background runspace
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
