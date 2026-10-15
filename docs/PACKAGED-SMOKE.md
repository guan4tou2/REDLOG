# Packaged smoke matrix

Run this after the unit, typecheck and production-build gates. It verifies the
artifact an operator installs, rather than the source checkout.

| Platform | Package | Required smoke |
| --- | --- | --- |
| macOS arm64 | `.app`, DMG/ZIP | Launch with a clean HOME; confirm the API port/token are created with `0600`; confirm health says no project is open; create a project and install the zsh or bash adapter. |
| Windows x64 | NSIS and portable | Launch each with a clean USERPROFILE; create a project; install PowerShell capture; run one command and confirm command and exit evidence. |
| Kali Linux | DEB/AppImage | First launch on a clean desktop, zsh/Bash enrollment, real stdout/stderr/exit and job-control recovery. |
| WSL | Windows install + selected distro | Select the explicit WSL Bash entry; run one command; confirm the Bash adapter is sourced and evidence returns to the Windows project. |

Every packaged build must also run:

```sh
npm run verify:package-resources
```

The gate requires the current bash, zsh and PowerShell adapters, their shared
runtime, the declarative starter pack and evidence verifier. It fails if any removed pre-release
compatibility hook is present.

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

Spec 052 T044 remains open for the rest of the manual quickstart, and T045
for the full first-install stopwatch. The ARM64 DEB is an acceptance artifact,
not verification of the published Linux x64 package. Windows portable/native
WSL, macOS actual quarantined download/Dock launch and notarization also remain
separate acceptance requirements. Earlier CI results above belong to bae0415;
new packaging changes require their own head-specific CI result.
