// RedLog's own plumbing, as seen by RedLog's own shell hooks.
//
// A shell hook reports every command the shell runs, and some of those
// commands are RedLog wiring itself up: the built-in terminal dot-sources the
// adapter into the pty it just spawned, the install flow tells the operator to
// run `. $PROFILE`, and the POSIX adapter's prompt function shows up under its
// own name. None of it is anything the operator did to a target.
//
// These used to be filtered where they were displayed — HOUSEKEEPING_SQL in
// event-queries.ts hid them from the Timeline, its counts and its aggregates.
// The rows were still written, still took a slot in the hash chain, and the
// export walks that chain row by row (it must: redlog-verify.py rejects any
// gap in `prev_hash`), so they reached the client inside events.jsonl anyway.
// Of the 24 shell commands in one real walkthrough bundle, 10 were this. A
// third party reading that file sees the operator running
// `. "C:\Users\<name>\...\hooks\shell-hook.ps1"` and `_tlogger_prompt_command`
// against the engagement, which leaks local paths and undermines the one thing
// the chain exists to establish.
//
// So the rule moves to ingest: plumbing never becomes an event. Filtering at
// the display layer could only ever hide it; the chain is written once.
//
// The matches stay deliberately narrow — anchored on RedLog's own adapter
// filenames and marker strings — because the cost of a false positive is an
// operator's real command silently missing from the record.

import { RETIRED_HOOK_FILES } from './runtime-preflight'

/** Adapter filenames RedLog sources into a shell.
 *
 *  The retired names come from `RETIRED_HOOK_FILES` rather than a second copy
 *  here: it is the same list, those files are still sitting in the rc files of
 *  operators who have not migrated, and a duplicate would drift. A repo guard
 *  (scripts/verify-specs.mjs) forbids naming them anywhere else, which is the
 *  same rule written down. */
const ADAPTER_FILES = [
  'shell-hook.ps1',
  'shell-bash-hook.sh',
  'shell-zsh-hook.zsh',
  'shell-common.sh',
  'start-transcript-hook.ps1',
  ...RETIRED_HOOK_FILES
]

/** Internal functions of the POSIX adapter, reported by name when the shell's
 *  DEBUG trap fires on the adapter's own prompt hook. */
const ADAPTER_INTERNALS = [
  '_tlogger_prompt_command',
  '_tlogger_preexec',
  '_redlog_prompt_command',
  '_redlog_preexec'
]

/** `. $PROFILE` / `. "…\Microsoft.PowerShell_profile.ps1"` — reloading the
 *  PowerShell profile, which is exactly what the install flow asks for
 *  ("Open a new PowerShell window, or run: . $PROFILE"). */
const PROFILE_RELOAD = /^\s*\.\s+(["']?)(\$PROFILE|.*Microsoft\.PowerShell_profile\.ps1)\1\s*;?\s*$/i

/**
 * Is this shell command RedLog wiring itself up, rather than operator work?
 *
 * Only ever consulted for shell command rows. Anything it returns true for is
 * dropped before it reaches the chain.
 */
export function isCapturePlumbing(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const cmd = command.trim()
  if (cmd === '') return false
  if (ADAPTER_INTERNALS.includes(cmd)) return true
  if (PROFILE_RELOAD.test(cmd)) return true
  // A command that sources one of our adapters. `terminal-manager` writes
  // ` . "<path>\shell-hook.ps1" *> $null; Clear-Host` into a fresh pty, and an
  // operator's rc file sources the POSIX ones the same way, so match the
  // filename anywhere in a dot-source / source line rather than pinning the
  // exact shape.
  const sourcing = /^\s*(\.|source)\s/.test(cmd)
  if (sourcing && ADAPTER_FILES.some((f) => cmd.toLowerCase().includes(f.toLowerCase()))) return true
  return false
}
