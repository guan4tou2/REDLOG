# Implementation Plan

## Constitution Check

- Canonical semantics: POSIX transport and output capture have one owner.
- Evidence integrity: payload fields, spool attribution and fallback behavior remain unchanged while zsh gains the canonical implementation.
- Explicit failure: adapters reject the wrong shell and missing runtimes.
- Architectural restraint: three supported adapters, no adapter framework.

## Canonical Interfaces

- `hooks/shell-common.sh`: POSIX transport, identity, spool and `redlog-run`.
- `hooks/shell-bash-hook.sh`: Bash lifecycle only.
- `hooks/shell-zsh-hook.zsh`: zsh lifecycle only.
- `hooks/shell-hook.ps1`: language-native PowerShell adapter using the same event field contract.
- `PluginManifest.supportFiles`: installer declaration for colocated runtime files.

## Phases

1. Add a failing boundary and manifest contract test.
2. Extract POSIX common behavior and create bash/zsh adapters.
3. Route every active caller directly to a shell adapter, teach the installer
   about support files, and remove historical combined entry points.
4. Verify hook behavior, manifest parity, build and desktop setup flow.
