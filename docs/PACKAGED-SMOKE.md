# Packaged smoke matrix

Run this after the unit, typecheck and production-build gates. It verifies the
artifact an operator installs, rather than the source checkout.

| Platform | Package | Required smoke |
| --- | --- | --- |
| macOS arm64 | `.app`, DMG/ZIP | Launch with a clean HOME; confirm the API port/token are created with `0600`; confirm health says no project is open; create a project and install the zsh or bash adapter. |
| Windows x64 | NSIS and portable | Launch each with a clean USERPROFILE; create a project; install PowerShell capture; run one command and confirm command and exit evidence. |
| WSL | Windows install + selected distro | Select the explicit WSL Bash entry; run one command; confirm the Bash adapter is sourced and evidence returns to the Windows project. |

Every packaged build must also run:

```sh
npm run verify:package-resources
```

The gate requires the current bash, zsh and PowerShell adapters, their shared
runtime, the starter pack and plugin runner. It fails if any removed pre-release
compatibility hook is present.

## 2026-09-22 macOS arm64 result

- Unpacked app generated with Electron Builder 26.15.3 and Electron 44.4.1.
- Packaged app launched successfully from `dist/mac-arm64` with a clean HOME.
- API port and token were created with mode `0600`.
- `/health` returned `503` with `No project open`, correctly distinguishing a
  running process from a capture-ready project.
- Packaged resource contract passed; removed compatibility hooks were absent.

Windows NSIS/portable and WSL remain release-matrix checks and are not claimed
as verified by the macOS run.
