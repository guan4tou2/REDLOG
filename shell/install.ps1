# Install RedLog PowerShell hook (Windows counterpart of install.sh).
#
# Runs: writes the bundled hook under $env:USERPROFILE\.redlog\ and prints
# the exact one-liner the operator appends to their $PROFILE. Idempotent —
# safe to re-run after an upgrade to refresh the hook script.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# (Bypass is scoped to this one script invocation; nothing persistent.)
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:USERPROFILE '.redlog\shell-hook.ps1'
$src = Join-Path $PSScriptRoot '..\hooks\shell-hook.ps1'
$src = [System.IO.Path]::GetFullPath($src)

New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Copy-Item -Force -Path $src -Destination $dest

Write-Host "Installed to: $dest"
Write-Host ""
Write-Host "Add this line to your PowerShell `$PROFILE:"
Write-Host "  . '$dest'"
Write-Host ""
Write-Host "Then: . `$PROFILE"
Write-Host ""
Write-Host "(If `$PROFILE doesn't exist yet, create it with:"
Write-Host "   New-Item -ItemType File -Force -Path `$PROFILE"
Write-Host "  and re-paste the line above.)"
