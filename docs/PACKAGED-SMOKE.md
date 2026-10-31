# Packaged smoke matrix

Run this after the unit, typecheck and production-build gates. It verifies the
artifact an operator installs, rather than the source checkout.

The [2026-10-24 internal acceptance record](../specs/062-recording-workflow-consolidation/internal-acceptance-20261024.md)
separates each candidate revision, failures, native layout checks and platform
CI results. A green installer workflow does not override a failed supplementary
export journey or certify Gatekeeper, WSL, physical disk-full or actual updates.

| Platform | Package | Required smoke |
| --- | --- | --- |
| macOS arm64 | `.app`, DMG/ZIP | Launch with a clean HOME; confirm the API port/token are created with `0600`; confirm health says no project is open; create a project and install the zsh or bash adapter. |
| Windows x64 | NSIS | Launch with a clean USERPROFILE; create a project; install PowerShell capture; run one command and confirm command and exit evidence. |
| Kali / Debian / Ubuntu x64 | DEB | First launch on a clean desktop, zsh/Bash enrollment, real stdout/stderr/exit and job-control recovery. |
| WSL | Windows install + selected distro | Select the explicit WSL Bash entry; run one command; confirm the Bash adapter is sourced and evidence returns to the Windows project. |

Every packaged build must also run:

```sh
npm run verify:package-resources
```

The gate requires the current bash, zsh and PowerShell adapters, their shared
runtime, the declarative starter pack and evidence verifier. It fails if any removed pre-release
compatibility hook is present.

## 2026-10-31 v0.18.5 prerelease (closed-beta candidate)

Release commit `0b714911`. The published assets were downloaded and checked
against the release's `SHA256SUMS.txt`:

| Asset | SHA-256 | Checked |
| --- | --- | --- |
| `RedLog.Setup.0.18.5.exe` | `04984f0083ce7c121592cdd62359e3427ee6e4a9e1c2356f9f602e1e8a793576` | downloaded, matches |
| `redlog_0.18.5_amd64.deb` | `ce300555e98bd75a3a2c9ebb90be8673fc0c669e7dca32d733383e7ef09468fc` | downloaded, matches |
| `RedLog-0.18.5-arm64.dmg` | `1122d7f829a36680683bcbb66cf95bba900fe7737ed94c4ed79984aa68f23e4a` | listed only, not downloaded |
| `RedLog-0.18.5-arm64-mac.zip` | `ab6cd4652d375c669a546d6fcbbf53fc0d9146fddfaa4a53a9a34f084bed231e` | listed only, not downloaded |

**Windows x64.** The published NSIS installer was unpacked with 7-Zip
(`$PLUGINSDIR/app-64.7z`), not installed, and `REDLOG_PACKAGED_APP` pointed at
its `RedLog.exe`. `packaged-smoke` passed: health before a project is open,
PowerShell capture with exit evidence, real mitmdump HTTP/HTTPS trusting only
the test-profile CA, export through the shipped verifier, and search after a
restart. `http-body-search`, `first-run` and `filtered-export` against the same
executable: 16 passed. The installer, shortcuts and uninstall are what
[windows-install-smoke run 41179031197](https://github.com/guan4tou2/REDLOG/actions/runs/41179031197)
covers on the same commit (PASS). That run builds its own package from the
commit; it does not install the published file.

**Kali x64, under WSL2 (not a Kali desktop).** The published `.deb` was
unpacked with `dpkg-deb -x` into a temp directory, not installed. Unpacked,
`chrome-sandbox` is not setuid, so the runs set `ELECTRON_DISABLE_SANDBOX=1`;
display was `xvfb-run`. Kali's apt ships mitmproxy 12.2.3 on Python 3.13,
where CI's pip resolves 11.x.

- `packaged-smoke` failed on its first run: the managed proxy reported
  `state: 'failed'` inside the 45-second poll. Terminal capture in the same run
  was recorded. Three later runs passed, one with an extra status read showing
  `running` and `certReady`, two unmodified. The reason for the failure was not
  captured, because the assertion did not print `error`; it does now. The
  cause turned out to be a port collision with a concurrent Windows run (see
  the follow-up below).
- `packaged-session-smoke`, `packaged-command-integrity`, `packaged-nc-upgrade`,
  `http-body-search`, `filtered-export` and `first-run`: 19 passed.
- [linux-install-smoke run 41179031359](https://github.com/guan4tou2/REDLOG/actions/runs/41179031359)
  on the same commit: PASS.

**macOS.** Not run; no macOS host this round. The DMG and ZIP hashes above
come from `SHA256SUMS.txt` only.

**Not covered by any of the above:**
- installing through the NSIS UI or `dpkg -i` on a desktop;
- SmartScreen and Gatekeeper;
- updating from v0.18.4 through electron-updater;
- a native Kali desktop;
- WSL NAT networking.

### Follow-up the same day: real installs

The first item above was then done on the operator's machines; the rest still
stand.

**Windows, upgrade from v0.18.4.** Both published installers were checked
against their release's `SHA256SUMS.txt`. Steps:
1. `RedLog.Setup.0.18.4.exe /S` installed to the default
   `%LOCALAPPDATA%\Programs\RedLog`.
2. `RedLog.Setup.0.18.5.exe /S` upgraded it in place to 0.18.5.
3. The installed `RedLog.exe` ran `packaged-smoke`, `http-body-search`,
   `first-run` and `filtered-export`: 17 passed.
4. `Uninstall RedLog.exe /S` removed the folder, both registry keys and both
   shortcuts. The PowerShell profile was unchanged, and no `~/.redlog` was
   created in the real profile.

What it leaves:
- `%LOCALAPPDATA%\redlog-updater\installer.exe`. This is electron-builder's
  installer copy for differential updates, and uninstall does not touch it.
- The in-app updater does not offer this build to v0.18.4. It runs on Windows
  only and leaves `allowPrerelease` at its default, so it only reads the Latest
  release, v0.18.3. Testers upgrade by running the new installer, as
  `INTERNAL-TESTING.md` says.

**An install folder deeper than about 120 characters cannot be upgraded.** The
first attempt installed under the session's scratch directory (135
characters). The v0.18.5 upgrade then stopped on a dialog even under `/S`:
"無法俺安裝舊的應用程式檔案。請嘗試再次執行安裝程式。: 2". The garbled
「俺安裝」 is electron-builder's own zh-TW string.

How it fails:
- On an upgrade, the old uninstaller renames every file into
  `$PLUGINSDIR\old-install`.
- NSIS `Rename` is limited to `MAX_PATH`.
- The deepest packaged files are 139 characters below the install root, so
  the rename fails and the uninstaller aborts with code 2.
- A plain uninstall from that folder leaves exactly those four files behind.

The four files are MSBuild leftovers that serve no purpose at runtime:
- `better-sqlite3/build/Release/obj/**/*.lastbuildstate`
- `node-pty/.../winpty/src/Release/obj/**/*.tlog`

Excluding them from the package would raise that limit. The default folder
(43 characters) is far below it.

**Kali, under WSL2.** `sudo dpkg -i redlog_0.18.5_amd64.deb` on kali-linux:
- The install linked `/usr/bin/redlog` and installed the desktop entry.
- `chrome-sandbox` was left `0755`, because user namespaces work there.
- The installed `/opt/RedLog/redlog` ran without `ELECTRON_DISABLE_SANDBOX`.
  Every Linux packaged spec, plus search, filtered export and first-run:
  20 passed.
- `dpkg -r` then `dpkg -P` removed the binary, the link, the desktop entry
  and the package record.

**The managed-proxy start failure was a port collision from the test run, not
a cold start.** A cold start was ruled out on Kali, after the WSL page cache
was dropped:
- the first `mitmdump --version` took 7.4 s, against the 30 s readiness limit;
- `packaged-smoke` passed four more cold runs.

The timeline gave the real cause:
- When the Kali run failed, Windows was running `http-body-search`,
  `first-run` and `filtered-export` in the background against the Windows
  build.
- Those specs open a project, and opening a project starts the managed proxy
  on `127.0.0.1:6661`.
- This WSL uses mirrored networking, so the distro shares the Windows
  loopback. Kali's mitmdump could not bind the port Windows already held.
- Every Kali run that passed ran after the Windows runs had finished.

Reproduced on purpose: a Windows listener on `127.0.0.1:6661` and the same Kali
run gave `state: 'failed'` again, with terminal capture intact. This time the
spec printed the reason: "127.0.0.1:6661 is already in use. Change the HTTP
capture port in Settings → Browser, or stop what is using it."

So the product behaved as designed: it refused the port it could not have and
said why. Two consequences:
- Under mirrored networking, a Windows RedLog and a WSL-native RedLog open at
  the same time compete for one port. The second one has to move its HTTP
  capture port.
- Packaged runs on Windows and in a mirrored WSL distro must not overlap.

## v0.18.2 distribution policy

Supported downloads are NSIS, DEB and DMG. The macOS ZIP remains a supplementary
archive. Windows portable and Linux AppImage targets and their active smoke
branches are removed; older results below are historical evidence. Linux
release packaging is required, not best-effort. Release verification rejects a
missing platform, a wrong version, unexpected portable packages and Windows
update metadata whose artifact, size or SHA-512 differs from the installer.
The retained DEB JSON is no longer cleared by a following AppImage journey.

## 2026-10-16 blocked release and macOS PTY correction

v0.18.1 was tagged but its macOS unit/PTY gate failed, so it did not publish
installers. The short-command loss was reproduced on a real macOS PTY: closing
the last slave before reading flushes queued output. The relay now retains its
slave copies until completion and queue drain; a deterministic RED/GREEN test
and all 52 focused boundary/capture/job-control assertions pass. The v0.18.1
tag and failed logs remain intact. v0.18.2 supersedes that unpublished attempt.

## 2026-09-22 macOS arm64 result

- Unpacked app generated with Electron Builder 26.15.3 and Electron 44.4.1.
- Packaged app launched successfully from `dist/mac-arm64` with a clean HOME.
- API port and token were created with mode `0600`.
- `/api/health` returns `200` with `ok: true, projectOpen: false` at the
  picker. A running API is not a capture-ready project.
- Packaged resource contract passed; removed compatibility hooks were absent.

Windows NSIS/portable and WSL remain release-matrix checks and are not claimed
as verified by the macOS run.

## 2026-10-14 recording candidate

The macOS ARM candidate DMG was mounted read-only, copied into an isolated
install folder and launched with isolated HOME/USERPROFILE. Tests exercised
actual shell stdout/stderr/exits, five explicit PTY sessions, builtin casts,
HTTP/HTTPS nonce checks using only the test-profile CA, sidecars, approved-plan
export, the shipped projection verifier, restart search and setup recovery.
This host was not a wholly clean OS; actual missing mitmdump was tested through
isolated tool/cache directories. Download quarantine/Gatekeeper/Dock launch
and notarization are not certified by this run.

Kali 2026.3 ARM container tests exercised Zsh stdout/stderr/exit and Bash
transport. This is not a Kali desktop installer result. Native WSL is not
available locally. The Windows NSIS workflow now exists on main (#334); its
current candidate run/conclusion must be recorded before calling Windows
acceptance complete. Do not infer success from a workflow file alone.

Windows main baseline 5be8f480: [NSIS clean-runner run 38500472248](https://github.com/guan4tou2/REDLOG/actions/runs/38500472248)
PASS. Build, clean-machine precondition, silent install, runner-profile first
launch, installed-app capture/export/HTTP smoke, no unexpected skipped steps
and silent uninstall all passed. This validates that baseline; the closeout
candidate still needs its own workflow conclusion. Native WSL was not included.

The direct FirstRun/enrollment/I/O launchers now honor REDLOG_PACKAGED_APP and
assert app.isPackaged. Their earlier combined source/package results are not
counted as wholly installed-app runs. Preparation/proof checks follow the real
missing-tool skip or the prepared host's automatic transition. Cast geometry
is checked through the recorded session's castPath, not a retired filename.
The shipped verifier case records eligible commands before and after a real
loopback flow. Current candidate results and exact CI revisions are in
[PR #335](https://github.com/guan4tou2/REDLOG/pull/335); a previous head's green
run does not validate later capture changes.

## 2026-10-15 historical candidate results (superseded package)

The recording results below remain valid, but this DMG must not be distributed
as the current candidate: a later strict bundle verification found Electron's
stale linker signature with no sealed resources. See the sealed candidate
follow-up below for the replacement artifact and its separate results.

Product revision `1606a2c`; verification revision `bae0415` changes only two
E2E fixtures. Both are on [PR #335](https://github.com/guan4tou2/REDLOG/pull/335).
The macOS ARM DMG SHA-256 is
`9d964ea671e39d3441e1c3c8f216841feacdedee6582655dca49783572180686`.

| Environment | Actual result | Limit |
| --- | --- | --- |
| Installed macOS ARM DMG copy | 27 journeys PASS, including actual missing-tool installation, 100 ordinary Zsh commands in 48,796ms, HTTP/HTTPS, filtered export, projection verifier, restart and project rotation/privacy | Isolated HOME, not a clean OS or downloaded/quarantined launch |
| Windows x64 NSIS clean runner | [Run 38580377642](https://github.com/guan4tou2/REDLOG/actions/runs/38580377642) PASS: package resources, clean precheck, install, own-profile first launch, native PowerShell, HTTP/HTTPS, eligible evidence before/after loopback, shipped verifier, no unexpected skips, uninstall | Does not test portable, WSL or every interactive tool |
| Linux Electron CI | [Run 38580377607](https://github.com/guan4tou2/REDLOG/actions/runs/38580377607): 131 PASS / 5 explicit SKIP | Built source output on Ubuntu, not a Kali installer |
| Kali 2026.3 ARM container | Actual Zsh/Bash stdout, stderr, exit and source identity PASS | Not a desktop VM, installer or shell-upgrade acceptance |

The same head's Windows unit suite has 3,281 PASS / 340 SKIP; Ubuntu has
3,596 PASS / 21 SKIP. Skips are not evidence of supported behaviour.
The earlier 1606a2c Linux E2E run had two fixture failures; those are retained
in the verification history. Current conclusions above use bae0415's runs.

Still required: Windows portable, Windows App + native WSL, Kali desktop
package/first-enrollment/job-control acceptance, and macOS actual download
quarantine/Gatekeeper, Dock launch and notarization. Spec 047 T010, Spec 052
T044/T045 and Spec 056 T015 remain unchecked for these reasons.
An ARM guest result must identify its architecture; it does not validate the
published Linux x64 installer. There is no merge or release claim here.

## 2026-10-15 sealed macOS and native Kali follow-up

The resource gate now runs `codesign --verify --deep --strict` on macOS.
It rejected the former app because its linker signature had no resource seal.
The replacement build uses explicit ad-hoc signing and the entitlements needed
for Electron/native modules. Verification passes on both the built app and the
copy installed from a read-only DMG mount. Modifying one shipped hook in a
throwaway copy makes verification fail. Ad-hoc signing does not authenticate
a publisher or provide notarization; Gatekeeper's read-only assessment still
rejects this candidate. No system policy was disabled.

Replacement macOS ARM DMG SHA-256:
`7a6dbbea8ce02022727ba3af710ad5f3e6da1565a1973df3e447dad942f431af`.
Its installed-app journeys: 26 PASS / 1 opt-in dependency-install SKIP.
After explicitly isolating Electron's user-data directory as well as HOME,
the changed 100-command and PTY-helper journeys both PASS again (62,432ms
for the 100-command interval). All four POSIX installed-only drivers now assert
`app.isPackaged`; selecting a source executable cannot satisfy them.
The actual missing-tool follow-up is separate from those 26 checks; an initial
attempt hit the existing 180-second download/install bound and is retained as
a failed run. Do not count that skipped or failed case as passed.

An operator-approved, isolated Kali 2026.3 **ARM64 desktop VM** now has an
experimental DEB built from `bae0415`. The operator installed it with apt;
all subsequent app/project/profile data use temporary homes. Original VMs and
their profiles were not changed. The guest network stays disabled; connection
tests use only its own loopback address.

- 100 ordinary Zsh commands: exactly one end row each, stdout, stderr and
  exit codes verified in the installed app. Recording interval 52,670ms;
  enrollment plus verification 52,828ms. This excludes installing the DEB and
  the operator's setup time, so it does **not** satisfy SC-001's stopwatch.
- Five explicit PTY sessions, automatic command capture, search and byte-for-
  byte profile removal PASS. Project rotation, per-pane stop/privacy and
  recording verification PASS on the same installed app.
- Native loopback `nc`: real Ctrl-Z/jobs/`stty raw -echo; fg`, peer data after
  resume, and all three descriptors still attached to `/dev/pts/` PASS against
  bare and enrolled shells. The start is `class: native`; the end is explicitly
  `metadata-only` / `interactive`. The first run incorrectly asserted `class`
  on the end row; its failure is retained, and the corrected contract passes.
- The operator also completed the upgrade in the visible Kali terminal and
  supplied a screenshot showing resumed peer data. Independent polling saw
  stop/resume and terminal descriptors; the app's local chain verifies. The
  controller reached its ten-minute wait limit before the acknowledgement
  marker arrived (`completed: false`), so this is recorded as human-confirmed
  evidence, not a wholly successful unattended controller run. Remote timestamp
  anchoring could not complete in the deliberately offline guest.

The final installed Kali group passes all five journeys in one run: 100-command
integrity, native nc upgrade, PTY helper/profile removal, actual managed
HTTP/HTTPS plus projection export/shipped verifier/restart, and pane rotation.
This run additionally isolates Electron user data and asserts the packaged
runtime. Its 100-command interval is 83,956ms (84,047ms including enrollment and
verification), measured under concurrent host verification; it supersedes the
earlier timing for this run, not the earlier run's result. HTTP tools were
prepared separately via verified public packages; this is not a successful
guest UI dependency-install or cold-download claim.

Spec 052 T044 remains open for the rest of the manual quickstart, and T045
for the full first-install stopwatch. The ARM64 DEB is an acceptance artifact,
not verification of the published Linux x64 package. Windows portable/native
WSL, macOS actual quarantined download/Dock launch and notarization also remain
separate acceptance requirements. Earlier CI results above belong to bae0415;
new packaging changes require their own head-specific CI result.

## 2026-10-15 installation follow-up

The missing-tool installer now has a fifteen-minute overall bound instead of
three minutes, a visible elapsed wait, keyboard-accessible cancellation and
distinct cancelled/retry state. Navigation away, renderer reload/destruction
and app quit stop only the owned install tree. An installed-app journey
checks both child and grandchild exit while an unrelated process stays alive.
The renderer-reload case first failed with a hidden installer still running;
it is retained as a separate RED case.

A fresh private tool/cache install through the signed macOS candidate took
79,217ms and reached actual HTTP and HTTPS nonce checks using only the private
test-profile CA. This run's network was faster than the earlier eight-minute
download; the speed difference is not attributed to the timer change. An
eight-minute simulated installer remains alive and succeeds, while a hung
installer is stopped at fifteen minutes. Earlier cold-install failures remain
part of the history.

After fixing renderer ownership, the final installed macOS candidate passes
12 journeys, including actual cancellation/navigation/reload of the owned
process tree and a new private cold install taking 119,834ms followed by HTTP
and HTTPS nonce proof. Ten setup/recovery cases in that group mock IPC results;
they are not ten additional real downloads. Final DMG SHA-256:
`86431a33ac5a73dc5b57b6bf98796ba152a5fe0bb123681e7640ed549fdf97a8`.
Strict ad-hoc signature verification passes; this is not notarization. The
79,217ms candidate predates the renderer-reload fix and is historical evidence.

New native x64 CI paths exercise actual DEB installation/removal, the relocated
AppImage wrapper, and the actual Windows self-extracting portable wrapper.
Building those workflows is not a passing result: their head-specific
conclusions and package checksums must be recorded in PR #335. Portable capture
checks builtin output/cast, external PowerShell command/exit, export/verifier
and process-termination/restart; it does not claim graceful portable temporary-
directory cleanup or WSL coverage. Ubuntu x64 results do not replace the full
manual Kali desktop quickstart.

All installed smoke reports pass through scripts/verify-smoke-report.mjs.
Zero tests, skipped tests, flaky/failed tests, absent summary data and any
not-exercised annotation fail the gate. Candidate artifacts remain distinct
from a release. WSL, full manual first-enrollment timing and actual Mac
quarantine/Dock/notarization stay open.

The first native x64 follow-up at ddea520 has an important RED: the DEB installs
and five journeys pass, but its first builtin command is absent from events.
Installed macOS Bash reproduces it: the cast executes the canary at 0.224s,
while hook injection happens at 0.604s. A real prompt was visible during the
fixed 600ms delay. Startup now enqueues the source line before the pane is
returned to the renderer; the package test requires the real output line in
the cast as well as its command/end row. No test sleep is added to mask it.

ddea520 NSIS passes its complete install/capture/export/uninstall flow. Its
portable wrapper launches, but the driver tries to use the terminal while
still on missing-HTTP-tool preparation; the driver now explicitly continues
to independent command proof. The original failed jobs remain evidence, and
AppImage was not reached in that failed DEB run. New native results must be
recorded for the corrected head.

The corrected installed macOS candidate passes all thirteen journeys with Bash
selected, including the immediate first-command output and real HTTP(S),
export/verifier and restart. The JSON gate confirms zero skips/not-exercised;
ten setup/recovery cases use controlled IPC, while the process-lifecycle,
cold-install/HTTP and full package journey are actual installed paths. Cold
installation takes 42,381ms, without attributing network speed to the timer.
The startup-order candidate supersedes the 86431a… candidate; its SHA-256 is
`39acaebdb1b8c85f1be53f2d87a6320752f59216d21f6c1b9b15e5b7cf13a9a6`.
Local ordered gates: 3,605 PASS / 24 SKIP. One prior external Zsh output
downgrade remains in raw evidence; its focused six-test and subsequent full
reruns pass without changes to that adapter. No retrospective cause is claimed.
