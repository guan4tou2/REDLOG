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
hook scripts resolve this via `cmd.exe /c 'echo %USERPROFILE%'` + `wslpath`.

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

The bash/zsh `shell-preexec-hook.sh` also works inside WSL — source it in your
WSL distro's `~/.bashrc` or `~/.zshrc`.

---

## 6. Operational Privacy

### 6.1 Workspace isolation (primary control)

Source hooks **only** in engagement shells. Commands in unhooked shells are never
logged. A clean pattern: do engagement work in a dedicated WSL distro with the
hook in `~/.bashrc`; keep personal work on the Windows host (unhooked).

### 6.2 Pause limitation

The status-bar recording toggle only hides events from the live timeline — it
does **not** stop database writes. For genuine isolation, stop the producer
(unsource the hook or close the engagement workspace).

### 6.3 Per-engagement isolation

Each project is a separate SQLite DB (`~/.redlog/projects/<id>/`). Close /
switch the project when you stop working an engagement.
