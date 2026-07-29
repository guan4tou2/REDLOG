# Windows & WSL Setup

Setup, packaging, and WSL integration for running RedLog on Windows — plus how
to keep an operator's private activity out of the engagement record.

---

## 1. Prerequisites

RedLog uses the native module `better-sqlite3`, which must be compiled for
Electron's ABI (`npm run rebuild`). That needs a C/C++ toolchain.

| Requirement | Notes |
|---|---|
| **Node.js 20 or 22 (LTS)** | **Not 24+** — newer Node has no prebuilt `better-sqlite3` binary yet, forcing a source build. |
| **Visual Studio Build Tools** | Install the **"Desktop development with C++"** workload. |
| **Python 3** | Required by `node-gyp` for the native rebuild. |

```powershell
# Build tools (then tick "Desktop development with C++" in the installer)
winget install Microsoft.VisualStudio.2022.BuildTools

# Node 22 LTS
winget install --id OpenJS.NodeJS.22 -e
```

> If you already have Node 24, remove it first (or use a version manager) so
> `node -v` reports 20.x or 22.x.

### PowerShell notes

- Windows PowerShell 5.1 does **not** support `&&`. Either install PowerShell 7
  (`winget install Microsoft.PowerShell`, run as `pwsh`) or chain with
  `cmd1; if ($?) { cmd2 }`.
- If `npm` in PowerShell reports *"running scripts is disabled"*, allow user
  scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 2. Build & run

```powershell
npm install
npm run rebuild        # compile better-sqlite3 for Electron's ABI
npm run dev            # launch the app
npm run build          # production compile (no installer)
```

---

## 3. Packaging (Windows installer)

Installers are produced by [electron-builder](https://www.electron.build)
(config: `electron-builder.yml`; the win target builds an NSIS installer and a
portable exe). Native deps are rebuilt for the target Electron automatically
during packaging. Releases are also produced by the GitHub Actions workflow
(`.github/workflows/release.yml`) on tags.

```powershell
npm run build                 # compile main/preload/renderer
npx electron-builder --win    # NSIS + portable -> dist\
```

**First-run note:** electron-builder downloads `winCodeSign`, which contains
macOS symlinks. Extracting symlinks on Windows needs a privilege standard users
lack. With electron-builder 26 this generally works unattended; if you hit
*"Cannot create symbolic link"*, either enable Windows **Developer Mode**
(Settings → For developers) or run the packaging command once from an elevated
terminal to populate the cache — subsequent builds work without elevation.

Output (installer + `win-unpacked/`) lands in `dist/`.

---

## 4. WSL integration

Pentest tooling often runs in WSL. To let a WSL shell log into RedLog running on
Windows, two things must line up.

### 4.1 Token/port location

RedLog writes `api-token` and `api-port` to the **Windows** user profile
(`%USERPROFILE%\.redlog\`), not WSL's Linux `$HOME`. The hook scripts resolve
this automatically via `%USERPROFILE%` + `wslpath` — note the profile folder
name can differ from `%USERNAME%`, so `%USERPROFILE%` is the reliable anchor.

### 4.2 Networking — mirrored mode is required

The API binds `127.0.0.1` on Windows. Under the default WSL2 **NAT** networking,
WSL's `127.0.0.1` is a separate loopback and **cannot reach it**. Enable
**mirrored networking** so localhost is shared:

1. Create `%USERPROFILE%\.wslconfig`:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
2. `wsl --shutdown` (from Windows PowerShell), then reopen WSL.
3. Verify: `wslinfo --networking-mode` → `mirrored`.

To revert, remove that line and `wsl --shutdown` again.

### 4.3 Logging from WSL

Two helper scripts live in `hooks/`:

```bash
# Diagnose the WSL -> RedLog link (env, token path, reachability, round-trip)
bash /mnt/c/Users/<you>/Desktop/REDLOG/hooks/wsl-redlog-test.sh

# Send an event from any script/hook (fire-and-forget; no-ops if unreachable)
hooks/redlog-send.sh "nmap -sV $TARGET" command_start
nmap -sV "$TARGET"
hooks/redlog-send.sh "nmap -sV $TARGET" command_end "{\"exit_code\":$?}"
```

`redlog-send.sh` resolves the token path (native or WSL), probes a reachable host
(shared loopback under mirrored networking; the WSL2 gateway otherwise), caches
it, and silently no-ops when RedLog is not running or reachable.

---

## 5. Operational privacy & isolating private activity

RedLog is a passive recorder for an engagement. An operator also does **private**
things on the same machine (personal browsing, personal shells, credentials).
The goal: keep private activity out of the tamper-evident engagement DB.

### 5.1 Instrument only the engagement workspace (primary control)

Isolation is most reliable at the **source** — control *where* producers run,
not just what the UI shows.

- **Dedicated engagement shell/distro.** Source the shell hook (or call
  `redlog-send.sh`) **only** in the shell, WSL distro, VM, or OS user you use for
  the engagement. Commands you run in your personal shell are never hooked.
- **Hooks fail safe.** Every hook no-ops when RedLog isn't running or the API
  isn't reachable, so activity outside an active engagement session isn't logged.
- **Screenshots are deliberate.** Captures are manual / API-triggered, not a
  passive desktop grabber — you choose when a screenshot (which may include
  private windows) is taken.

A clean pattern on Windows: do all engagement work inside a dedicated **WSL
distro** with the hook sourced in that distro's `~/.bashrc`, and keep personal
work on the Windows host (unhooked).

### 5.2 Pausing — understand the current limitation

The status-bar recording toggle sets a paused flag. **Today this only hides
events from the live timeline — it does not stop database writes.** Any producer
that POSTs to `/api/events` while "paused" is still persisted. Treat the toggle
as *hide*, not *stop*.

For genuine isolation right now, **stop the producer** (unsource/disable the
hook, or close the engagement workspace) rather than relying on pause.

> Planned hardening: gate persistence on the paused flag so the toggle truly
> stops capture, while still recording a pause/resume boundary marker for audit
> integrity; plus per-producer enable/disable in project config. Until then, use
> workspace isolation (§5.1) as the real control.

### 5.3 Per-engagement isolation (built in)

Each project is a separate directory and SQLite DB
(`~/.redlog/projects/<id>/`), so engagements never cross-contaminate. Close /
switch the project when you stop working an engagement.

### 5.4 Scope

Configure `scope.targets` / `excludeTargets` so out-of-scope hosts are flagged.
Combined with workspace isolation, this keeps the record focused on the
engagement.
