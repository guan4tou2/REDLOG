# RedLog — Windows compatibility audit

Read-only audit of POSIX assumptions that would silently break RedLog on
Windows, ranked so the fix queue is obvious. Scope: `src/`, `cli/`, `hooks/`,
`shell/`, `test/`, `e2e/`, `redlog-share-worker/`, `examples/plugins/`,
top-level scripts, and CI.

## Fixed since audit (2026-08-18)

The following issues were discovered and fixed during a comprehensive Windows
integration test session. Commits: `0a7f81e`, `6c30b00`.

| Fix | Commit | Files |
|---|---|---|
| **Process-monitor ignore list** only checked `/` separator — Windows `\` paths never matched. Added `\\` matching. | `6c30b00` | `process-monitor.ts` |
| **`cwdPassesGate` trailing separator** strip only handled `/`. Windows root paths with trailing `\` failed gate comparison. Fixed regex to `[\\/]`. | `6c30b00` | `tailer-host.ts` |
| **CRLF in JSONL parsing** — `.split('\n')` left trailing `\r` on CRLF files, breaking `JSON.parse`. Added `\r` stripping. | `6c30b00` | `tailer-host.ts` (x2), `agent-transcript-tailer.ts` |
| **Bash DEBUG trap** fired during `source`, producing ghost `command_start` events. Fixed with deferred arming (`_REDLOG_TRAP_ARMED` flag). | `0a7f81e`, `6c30b00` | `shell-preexec-hook.sh` |
| **`.bashrc` hook path** written with Windows backslashes by pre-guard `installHook()`. Manual fix to POSIX path. Related to P0-3. | manual | `~/.bashrc` |

**Security advisory (not fixed):** `mode: 0o600` for `api-token` and Ed25519
signing keys is silently ignored on NTFS. Files inherit the parent directory's
ACL, potentially exposing secrets on shared workstations. Recommendation: use
`icacls` to set per-user ACLs on Windows.

---

## Summary

- **Total issues: 14** — **3 blocking (P0)**, **6 annoying (P1)**, **5 cosmetic
  (P2)**. Plus **5 additional issues found during integration testing** (see above).
- The runtime code is in surprisingly good Windows shape: `os.homedir()`,
  `path.join`, `pathToFileURL`, `windowsHide: true`, a real PowerShell hook,
  and per-platform branches in `network-info.ts` / `opsec-state.ts` all check
  out.
- The real fragility is **process boundary**: CI does not build or run tests
  on Windows at all, and one production code path still reads `process.env.HOME`
  directly. Everything else on the P1 list is one commit each.
- The `shell-source` install method is Unix-only by design; the PowerShell
  operator is expected to hand-install via `$PROFILE`. That's OK for v1 but
  the UI copy makes it look like there's an installer.

---

## Blocking (P0)

### P0-1 · CI does not exercise Windows at all
- **File**: `.github/workflows/ci.yml:14`, `.github/workflows/ci.yml:36`
- **Symptom**: `unit` and `e2e` jobs both `runs-on: ubuntu-latest`. `release.yml`
  builds a Windows installer but never runs `npm test`. Any regression that
  only manifests on `win32` — including every issue below — lands unnoticed
  until an operator downloads the installer.
- **Fix**: Add `strategy.matrix.os: [ubuntu-latest, windows-latest]` to the
  `unit` job. Skip e2e on Windows initially (Electron + Playwright on the
  Windows GHA runner is a separate can) but at minimum run Vitest + `npm run
  build` on Windows so `hooks-manager`, `marketplace`, `cloud-share`,
  `publisher-trust`, `plugins`, `api-server` tests execute against Windows
  path semantics.

### P0-2 · `terminal-manager.ts` reads `process.env.HOME` as the pty cwd
- **File**: `src/main/terminal-manager.ts:115`
  ```ts
  const cwd = process.env.HOME || os.homedir()
  ```
- **Symptom**: On a plain Windows shell `HOME` is unset and `os.homedir()`
  wins, so it's fine. But Git for Windows and MSYS2 set `HOME` to a
  POSIX-shaped path like `/c/Users/foo`, which is not a valid Win32 filesystem
  path. `pty.spawn` will either fail outright (`ENOENT`) or the PowerShell
  session will start in whatever fallback dir ConPTY chooses, silently
  losing the "open in home" contract. This is the exact WSL/Git-Bash user
  the docs explicitly target.
- **Fix**: `const cwd = os.homedir()` (drop the HOME preamble). If a
  Unix-shell-inside-Windows use case wanted `$HOME`, spawn that shell as
  the child instead of the OS shell.

### P0-3 · The `shell-source` install path silently corrupts a Windows profile
- **File**: `src/core/hooks-manager.ts:171` (`shellRcFor`), used at 373 and 417
  ```ts
  return process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc'
  ```
- **Symptom**: If any `shell-source` capture is ever "installed" on Windows
  (either because a plugin ships one, or a user runs Git Bash and `SHELL` is
  set), RedLog will `join(homedir(), '.bashrc')`, and (a) copy the `.sh` hook
  to `%USERPROFILE%\.redlog\shell-preexec-hook.sh`, (b) append
  `source <win-path>` to `%USERPROFILE%\.bashrc`, and (c) report success. On
  the next PowerShell/cmd session nothing runs; if the user then opens Git
  Bash the raw Windows path in the `source` line fails.
- The built-in captures gate this: `shell-bash` requires `/bin/bash`,
  `shell-zsh` requires `/bin/zsh`, and both `existsSync` checks return false
  on stock Windows (`hooks-manager.ts:235-238`), so today's UI won't offer
  the button. But a **plugin-contributed** `shell-source` capture registered
  via `registerCapturePlugins` skips that gate entirely — `checkAvailable`
  returns `true` for any external capture with no `requires` (line
  228-241) — and there is no defence-in-depth check at install time.
- **Fix**: In `installHook` / `uninstallHook`, refuse the `shell-source`
  branch when `process.platform === 'win32'` with a clear message
  ("Windows uses PowerShell $PROFILE — see docs/windows-setup.md"). Or teach
  `shellRcFor` to detect PowerShell and rewrite the append to
  `Add-Content $PROFILE` — but the refusal is a smaller diff and matches
  what the manual-steps flow already produces for `shell-powershell`.

---

## Annoying (P1)

### P1-1 · Plugin manifest path-escape check misses Windows absolutes
- **File**: `src/core/plugins/manifest.ts:69`
  ```ts
  if (rel.includes('..') || rel.startsWith('/')) return { ok: false, ... }
  ```
- **Symptom**: The check that a plugin's `contributes` refs stay inside the
  plugin dir treats `/foo` as absolute but lets `C:\foo`, `c:/foo`, `\\?\C:\`,
  and `\foo\bar` through. On Windows a malicious plugin can point `mcpTools`
  at an absolute path outside the extracted dir; `existsSync(join(dir, rel))`
  then resolves against the drive root, not the plugin dir.
- **Fix**: Replace with `path.isAbsolute(rel)` (handles both platforms) and
  reject any rel whose `path.normalize` starts with `..`. Same treatment for
  `assertInsideDir` in `src/core/plugins/marketplace.ts:327` — the current
  `currentReal.startsWith(rootReal)` there works because both sides come
  from `resolve()`, so it's fine — but drift-proof it by switching to a
  `path.relative(root, current)` guard.

### P1-2 · Screenshot delete/read guard is case-sensitive on Windows
- **File**: `src/main/index.ts:830`, `src/main/index.ts:843`
  ```ts
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(screenshotDir)) return null
  ```
- **Symptom**: NTFS is case-preserving but case-insensitive. If the renderer
  sends a screenshot path with a different drive-letter case
  (`c:\Users\foo\.redlog\...` vs the project dir's `C:\Users\foo\...`) — which
  happens whenever the string flows through `.toLowerCase()` or a URL
  round-trip — the safety check rejects a legitimate delete and the UI shows
  "path outside project". Also biases toward the wrong direction for a
  security check: a crafted `..\` path that resolves back inside the dir but
  via a symlink would slip past `startsWith`.
- **Fix**: `path.relative(screenshotDir, resolved)` + assert result doesn't
  start with `..` and isn't absolute; case-fold both sides on `process.platform
  === 'win32'`.

### P1-3 · TerminalView cwd splitter breaks on backslash paths
- **File**: `src/renderer/src/components/TerminalView.tsx:91`
  ```ts
  ? { ...tab, cwd: d.cwd?.split('/').pop() || tab.cwd, ... }
  ```
- **Symptom**: When (not if) the PowerShell hook is extended to emit `cwd`
  — the bash preexec hook already does — the tab label will be the entire
  Windows path (`C:\Users\foo\proj`), because `split('/')` finds no
  separator. Not a crash, but the tab bar becomes unreadable.
- **Fix**: `d.cwd?.split(/[\\/]/).pop()`. One character.

### P1-4 · Marketplace tar shell-out uses bare `tar`
- **File**: `src/core/plugins/marketplace.ts:350`
  ```ts
  spawnSync('tar', ['-xzf', tmpTar, '-C', destDir, '--strip-components=1'], …)
  ```
- **Symptom**: `spawn('tar', …)` on Windows relies on CreateProcess appending
  `.exe` from `PATHEXT`. In a normal user's shell this finds Windows 10 1803+
  bsdtar and works. But under an Electron app launched from Explorer the
  inherited PATH is what the Electron shim decided, and if `%SystemRoot%\
  system32` isn't first (a real problem when a broken installer prepends its
  own dir), the plugin install throws `ENOENT: tar`. `cloud-share.ts:231`
  already knows to say `'tar.exe'` on `win32`; do the same here.
- **Fix**: `const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'`,
  then `spawnSync(tarBin, …)`. Same three-line change gives explicit
  ENOENT diagnostics.

### P1-5 · MCP `stdioPath` uses `.js`, invoked without a shebang on Windows
- **File**: `src/main/index.ts:1336-1337`, `src/main/index.ts:1341`
- **Symptom**: `mcp:info` hands the operator the string
  `<resourcesPath>\mcp\redlog-mcp-server.js` so they can paste it into
  `claude mcp add`. On macOS/Linux the shebang runs it under `node`; on
  Windows there is no shebang execution and `claude mcp add …\redlog-mcp-
  server.js` fails with "not an executable" unless the user prepends `node`.
- **Fix**: Either return a `command` + `args` pair (`node`, `[stdioPath]`)
  instead of a bare path, or additionally write a `.cmd` shim next to the
  `.js` at package time.

### P1-6 · `shell-preexec-hook.sh` auto-source hard-codes forward-slash rewrite
- **File**: `src/main/terminal-manager.ts:222`
  ```ts
  : ` source "${hookPath.replace(/\\/g, '/')}" >/dev/null 2>&1; clear\r`
  ```
- **Symptom**: The non-PowerShell branch assumes the resolved absolute
  `hookPath` came from Node's `path.join` and needs POSIX separators for
  `source`. Fine on macOS/Linux. On Windows the only way this branch
  actually fires is if the operator has set `SHELL` to something matching
  neither `powershell` nor `pwsh` (e.g. `bash.exe`) — in which case the
  rewritten path (`/C:/Users/…`) is invalid to `source` in bash. Add
  cygpath/wslpath conversion or refuse the branch on `win32`.
- **Fix**: Wrap the branch in `process.platform !== 'win32'` and fall back
  to the PowerShell command; sourcing an `.sh` into a Windows-native bash
  needs `cygpath -u` and nobody's asked for it yet.

---

## Cosmetic (P2)

### P2-1 · `shell/install.sh` has no PowerShell counterpart
- **Files**: `shell/install.sh` (67 lines of bash), no `shell/install.ps1`.
- **Impact**: Docs (`docs/windows-setup.md:73`) explicitly send Windows users
  to `Add-Content $PROFILE '. "path"'`, so nothing is broken today — but the
  presence of `install.sh` and absence of `install.ps1` reads as "we forgot"
  during onboarding. Ship a matching one-liner PS1 or delete the sh and
  link the docs.

### P2-2 · `commandExists('bash')` on Windows returns true even for `bash.exe` shims
- **File**: `src/core/hooks-manager.ts:237`
- **Impact**: WSL's `bash.exe` under `C:\Windows\System32` satisfies `where
  bash`, so `checkAvailable('shell-bash')` says "installed" and the UI
  offers the install button — which then runs `shellRcFor` = `.bashrc`,
  triggering the P0-3 corner case. Guarded already by P0-3's fix; low
  severity on its own.

### P2-3 · `cloud-share.ts` Windows branch assumes 1803+ bsdtar without a probe
- **File**: `src/core/cloud-share.ts:231`
- **Impact**: Windows Server 2016 and un-patched Windows 10 (pre-1803) don't
  ship `tar.exe`. Users get `tar.exe exit null:` with no actionable hint.
  Cheap fix: pre-check `spawnSync('where', ['tar.exe'])` and surface an
  error message pointing at the docs.

### P2-4 · Line-ending sensitivity in `autoUpgradeInstalledHooks`
- **File**: `src/core/hooks-manager.ts:465-467`
  ```ts
  if (installed === bundled) continue
  ```
- **Impact**: Byte-equality compare. `.gitattributes` forces LF for `.sh`, so
  the bundled artifact has LF; if a Windows editor rewrites the installed
  copy with CRLF, `installed !== bundled` and the auto-upgrade heuristic
  proceeds to the `isBrokenShellHook` gate — which happens to preserve user
  edits, so the outcome is "no upgrade". Correct today; add a normalize-
  before-compare if you ever add a "silently upgrade clean hooks" path.

### P2-5 · Windows candidate list for Chromium is missing common installs
- **File**: `src/main/services/browser-launcher.ts:33-39`
- **Impact**: Only the machine-wide `Program Files` and `Program Files (x86)`
  paths are checked. Per-user Chrome installs live at
  `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` and are the default
  when a non-admin runs the Chrome installer — those users see "No
  Chromium-based browser found" until they hand-pick the path. Add
  `path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\
  chrome.exe')` and the Edge/Brave equivalents.

---

## What's already correct

Checked and verified Windows-safe:

- **Home dir**: 20+ call sites (`api-server.ts`, `hooks-manager.ts`,
  `marketplace.ts`, `publisher-trust.ts`, `trust.ts`, `state.ts`, `loader.ts`,
  `project-manager.ts`, `cloud-share-uploader.ts`, `cli/redlog-cli.js`) all
  use `os.homedir()`, which resolves via `USERPROFILE` on Windows.
- **Path joins**: no `path.join(a, 'b/c')` in production code; the only
  string-with-slash join in the manifest write (`bundle-export.ts:122,138`)
  is deliberate — `screenshots/${name}` is manifest-format-relative, not a
  filesystem path.
- **`file://` URLs**: `cloud-share-uploader.ts:68,78` uses `pathToFileURL`;
  `test/cloud-share.test.ts` + `e2e/cloud-share-flow.spec.ts` use
  `fileURLToPath`. Round-trip works on Windows.
- **Shell-out to system tools**: `network-info.ts` and `opsec-state.ts`
  branch on `process.platform` and use `netsh` / `Get-DnsClientServerAddress`
  / `Get-NetRoute` on Windows, all with `windowsHide: true`.
- **Signals**: no `SIGHUP/KILL/TERM/INT` usage in Node code. The only signal
  mention is a UI comment in `TerminalView.tsx`.
- **Symlinks / chmod**: `chmod 0o600` writes exist but are Node's no-op on
  Windows; `test/redlog-sign.test.ts:75-78` explicitly gates the mode-check
  on `process.platform !== 'win32'`. No `fs.symlinkSync` anywhere in
  production; `marketplace.ts:334` refuses symlink entries in extracted
  plugin tarballs.
- **Tests**: `test/publisher-trust.test.ts`, `test/plugins.test.ts`,
  `test/marketplace.test.ts`, `test/cloud-share.test.ts` all swap **both**
  `HOME` and `USERPROFILE` in `beforeEach`. `e2e/helpers.ts:47-48` does
  the same for the Electron launch env. Cleanup uses
  `fs.rmSync(dir, { recursive: true, force: true })` (Windows-friendly).
- **Case sensitivity in filenames**: no `===` compare of paths as case-
  sensitive strings in the hot paths (`marketplace.ts:215` explicitly
  `.toLowerCase()`s both sides of the sha256).
- **Registry / ACL / long-path**: RedLog does none of these directly. Not
  applicable.
- **PowerShell hook**: `hooks/shell-hook.ps1` and `hooks/redlog-send.ps1`
  exist, use `$env:USERPROFILE`, and are documented in
  `docs/windows-setup.md`.
- **Electron switches**: `src/main/index.ts:52-55` sets Windows-specific
  DirectComposition/DirectWrite switches only on `win32`.

---

## Untestable without a Windows box

- **node-pty ConPTY behaviour** in Electron 33: whether the launched
  PowerShell inherits ConPTY correctly under a packaged NSIS install.
  Reading the code, the pty invocation is correct; the "auto-source ps1"
  path on line 220-224 assumes `Clear-Host` works — untested here.
- **electron-builder NSIS install** actually placing `hooks/`, `shell/`,
  `mcp/`, and `plugin-runner.js` under `resources/` in the right shape.
  `electron-builder.yml:12-21` says it does; can't verify.
- **`spawn('tar', …)` PATH resolution** under a packaged Electron app on a
  fresh Windows install — the P1-4 concern above is a guess based on how
  Electron shims `process.env.PATH`.
- **`os.homedir()` for a UAC-elevated launch** (`Program Files` install
  auto-elevates) — should still return the invoker's `USERPROFILE`, but
  worth a smoke test.
- **`utilityProcess.fork` for plugin-runner.js** on Windows with `stdio:
  'ignore'` — API is cross-platform but not exercised in CI.
- **`shell.openPath` on the plugins folder** when the folder path contains
  Unicode / spaces (Chinese usernames are common in the target audience).

---

## Follow-up work — proposed patch order

Do these in one or two branches; each is small.

1. **CI matrix (P0-1)** — add `windows-latest` to `ci.yml` unit job, keep
   e2e Linux-only for now. Every subsequent fix will land test coverage
   automatically.
2. **`terminal-manager.ts:115` HOME → homedir (P0-2)** — one-liner. Ship
   with a regression test that stubs `HOME=/c/Users/foo` and asserts the
   pty cwd is a Win32 path.
3. **`shell-source` refusal on Windows (P0-3)** — refuse the branch in
   `installHook` / `uninstallHook` when `platform === 'win32'`, with the
   copy the docs recommend. Adds two `if` blocks.
4. **Manifest path-escape (P1-1)** — swap the string check for
   `path.isAbsolute`. Same file: switch `assertInsideDir` to
   `path.relative` for safety-in-depth.
5. **Screenshot guard (P1-2)** — case-fold + `path.relative`; matches the
   pattern used elsewhere in the marketplace extractor.
6. **`tar` → `tar.exe` (P1-4)** — parity with `cloud-share.ts`.
7. **`mcp:info` returns command+args (P1-5)** — otherwise `claude mcp add`
   on Windows silently fails.
8. **TerminalView cwd split (P1-3)** — `[\\/]+` regex, one char.
9. **P2 items** — batch when someone next touches those files. None are
   worth a dedicated commit today.

The whole P0+P1 set is under 100 lines of code. What's missing is the CI
signal to keep it that way.
