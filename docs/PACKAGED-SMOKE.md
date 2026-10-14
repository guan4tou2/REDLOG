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
