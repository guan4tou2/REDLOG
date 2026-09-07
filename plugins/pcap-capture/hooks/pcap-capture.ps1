# pcap-capture (Windows): make the packets the connection monitor can't see
# (nmap -sS SYN scans, masscan, UDP scans) visible on the RedLog timeline.
# Uses tshark (Wireshark's CLI) over npcap — so it needs npcap installed and an
# elevated (Administrator) shell, which RedLog itself does not hold. Run it
# yourself, elevated:
#
#   powershell -ExecutionPolicy Bypass -File pcap-capture.ps1 -Interface "Ethernet"
#
# Capture nothing while RedLog is closed (a flow with nowhere to attribute is
# not evidence). Ctrl-C to stop. List interfaces with:  tshark -D
param(
  [Parameter(Mandatory = $true)] [string] $Interface
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# --- Honest preflight: say exactly why it can't capture ---
if (-not (Get-Command tshark -ErrorAction SilentlyContinue)) {
  Write-Error "[redlog pcap-capture] tshark not found on PATH. Install Wireshark (which bundles tshark) and npcap, then re-run. Packet capture is unavailable until then - the timeline still has the commands, just not their raw packets."
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "[redlog pcap-capture] node not found on PATH (needed to post flows to RedLog)."
  exit 1
}
# npcap capture needs Administrator (or the operator in the npcap group).
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Error "[redlog pcap-capture] not elevated - npcap capture needs Administrator. Re-run this in an elevated PowerShell (Run as administrator)."
  exit 1
}

Write-Host "[redlog pcap-capture] capturing on '$Interface' via tshark (Ctrl-C to stop)..."
& node (Join-Path $here 'pcap-capture.js') '--tshark' $Interface
exit $LASTEXITCODE
