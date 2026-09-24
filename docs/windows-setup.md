# Windows & WSL Setup

Running RedLog on Windows — build environment, PowerShell hooks, WSL integration,
and operational isolation.

---

## 1. Prerequisites

RedLog uses `better-sqlite3` (native C++ module), which must be compiled for
Electron's ABI. That requires a C/C++ toolchain.

| Requirement | Notes |
|---|---|
| **Node.js 20 or 22 (LTS)** | Not 24+ — no prebuilt `better-sqlite3` binary yet. |
| **Visual Studio Build Tools** | Install the **"Desktop development with C++"** workload. |
| **Python 3** | Required by `node-gyp`. |

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
winget install --id OpenJS.NodeJS.22 -e
```

### PowerShell notes

- Windows PowerShell 5.1 does **not** support `&&`. Either install PowerShell 7
  (`winget install Microsoft.PowerShell`, run as `pwsh`) or chain with
  `cmd1; if ($?) { cmd2 }`.
- If `npm` reports *"running scripts is disabled"*, allow user scripts once:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 2. Build & Run

```powershell
npm install
npm run rebuild        # compile better-sqlite3 for Electron's ABI
npm run dev            # launch the app
```

---

## 3. Packaging

Installers are built by [electron-builder](https://www.electron.build). The
GitHub Actions workflow (`.github/workflows/release.yml`) produces releases on
tags. To build locally:

```powershell
npm run build
npx electron-builder --win    # NSIS + portable → dist\
```

**First-run note:** electron-builder downloads `winCodeSign`, which may need
symlink privileges. Either enable **Developer Mode** (Settings → For developers)
or run the packaging command once from an elevated terminal.

---

## 4. PowerShell Shell Hook

The PowerShell hook (`hooks/shell-hook.ps1`) captures every command from
PowerShell 5.1+ and pwsh 7+ and sends it to RedLog's timeline.

### Quick start

```powershell
# Source in current session
. "C:\path\to\redlog\hooks\shell-hook.ps1"

# Or add to your profile for every session
Add-Content $PROFILE '. "C:\path\to\redlog\hooks\shell-hook.ps1"'
```

The hook:
- Overrides the `prompt` function to capture commands via `Get-History`
- Sends `command_start` + `command_end` events with exit code and duration
- Uses background runspaces so the prompt is never blocked
- No-ops silently when RedLog isn't running

### Event sender (scripting)

For custom scripts, use `hooks/redlog-send.ps1`:

```powershell
. ".\hooks\redlog-send.ps1"
Send-RedLogEvent "invoke-mimikatz" command_start
# ... run tool ...
Send-RedLogEvent "invoke-mimikatz" command_end @{ exit_code = 0 }
```

---

## 5. WSL Integration

Pentest tooling often runs in WSL. Two things must line up for WSL → RedLog.

### 5.1 Token path

RedLog writes `api-token` and `api-port` to `%USERPROFILE%\.redlog\`. The WSL
hook scripts first check `$HOME/.redlog/api-token` (works when WSL2 mirrored
networking shares the same filesystem view), then falls back to resolving the
Windows path via `cmd.exe /c 'echo %USERPROFILE%'` + `wslpath`.

### 5.2 Networking — mirrored mode

The API binds `127.0.0.1` on Windows. Under WSL2's default NAT mode, WSL's
`127.0.0.1` is a separate loopback. Enable **mirrored networking**:

1. Create `%USERPROFILE%\.wslconfig`:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
2. `wsl --shutdown` (from Windows PowerShell), then reopen WSL.
3. Verify: `wslinfo --networking-mode` → `mirrored`.

### 5.3 WSL hooks

```bash
# Diagnose the WSL → RedLog link
bash /mnt/c/Users/<you>/Desktop/REDLOG/hooks/wsl-redlog-test.sh

# Fire-and-forget event sender
hooks/redlog-send.sh "nmap -sV $TARGET" command_start
nmap -sV "$TARGET"
hooks/redlog-send.sh "nmap -sV $TARGET" command_end "{\"exit_code\":$?}"
```

The shell-specific adapters also work inside WSL: source `shell-bash-hook.sh`
from `~/.bashrc` or `shell-zsh-hook.zsh` from `~/.zshrc`. The Bash hook uses deferred trap arming
(`_REDLOG_TRAP_ARMED`) so shell init statements are never captured as user
commands.

> **Important:** When sourcing the hook from Git Bash on Windows, use a POSIX
> path — `source /c/Users/<you>/.redlog/shell-bash-hook.sh`, **not**
> `source C:\Users\<you>\.redlog\shell-bash-hook.sh` (backslashes are
> interpreted as escape characters).

---

## 6. Security Notes

### 6.1 File permissions on NTFS

RedLog writes `api-token` and Ed25519 signing keys with `mode: 0o600`, which
is enforced on Unix but **silently ignored on NTFS**. The files inherit the
parent directory's ACL, which typically grants read access to all local users.
On a shared workstation, restrict access manually:

```powershell
icacls "$env:USERPROFILE\.redlog\api-token" /inheritance:r /grant:r "$env:USERNAME:(R)"
icacls "$env:USERPROFILE\.redlog\signing-key.pem" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

---

## 7. Operational Privacy

### 7.1 Workspace isolation (primary control)

Source hooks **only** in engagement shells. Commands in unhooked shells are never
logged. A clean pattern: do engagement work in a dedicated WSL distro with the
hook in `~/.bashrc`; keep personal work on the Windows host (unhooked).

### 7.2 What pause does

Pausing (status bar, ⌘/Ctrl+., or `POST /api/recording`) stops RedLog from
**writing**, not just from displaying. The gate sits at the single database
write point, so every source is covered — the shell and PowerShell hooks, the
mitmproxy addon, the monitors. While paused:

- No event is written except RedLog's own audit trail (`system`, including the
  `recording_paused` / `recording_resumed` pair that explains the gap) and
  markers you create explicitly.
- Nothing is derived from the discarded events either — no scope violation,
  loot, pivot or target row that would leak the paused content.
- The built-in terminal keeps working, but its `.cast` recording stops growing.
  Periodic screenshots are skipped.
- The API answers a paused event with `200 {recording:false, skipped}`, so the
  hook does not spool the command and replay it after resume.

The hook still *sends* each command to `127.0.0.1` while paused; RedLog drops
it on arrival. If a command must never leave the shell at all, run it in a
shell that does not source the hook (see 7.1).

### 7.3 Per-engagement isolation

Each project is a separate SQLite DB (`~/.redlog/projects/<id>/`). Close /
switch the project when you stop working an engagement.
