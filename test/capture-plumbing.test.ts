import { describe, it, expect } from 'vitest'
import { isCapturePlumbing } from '../src/core/capture-plumbing'

// What RedLog's own shell adapters report about RedLog wiring itself up. None
// of it is operator work, and — unlike the display-time filter this replaces —
// dropping it at ingest is what keeps it out of the hash chain, and so out of
// the events.jsonl a client reads.
describe('isCapturePlumbing', () => {
  const plumbing = [
    // What terminal-manager writes into a freshly spawned pty.
    ' . "C:\\Users\\op\\Desktop\\REDLOG\\hooks\\shell-hook.ps1" *> $null; Clear-Host',
    'source /Users/op/.redlog/shell-bash-hook.sh',
    '. ~/.redlog/shell-zsh-hook.zsh',
    '. /home/op/.redlog/shell-common.sh',
    // Retired adapter names, still in an rc file until the operator migrates.
    'source ~/.redlog/shell-preexec-hook.sh',
    // The POSIX adapter's own prompt function, reported under its own name.
    '_tlogger_prompt_command',
    '  _tlogger_prompt_command  ',
    // Reloading the PowerShell profile — what the install flow asks for.
    '. $PROFILE',
    '. "C:\\Users\\op\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1"',
    ". 'C:\\Users\\op\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1'"
  ]
  it.each(plumbing)('drops %j', (cmd) => {
    expect(isCapturePlumbing(cmd)).toBe(true)
  })

  // The cost of a false positive is an operator's real command missing from
  // the record, so the matches stay anchored on our own names.
  const evidence = [
    'whoami',
    'id -un && echo done',
    'nmap -sV 10.0.0.5',
    // Mentions a hook file without sourcing it — reading or exfiltrating one
    // is operator work and must be recorded.
    'cat ~/.redlog/shell-bash-hook.sh',
    'scp shell-hook.ps1 op@10.0.0.5:/tmp/',
    'grep -r shell-hook.ps1 .',
    // Sources something of the operator's own.
    'source ./venv/bin/activate',
    '. ./env.sh',
    // Names a profile without reloading it.
    'cat $PROFILE',
    'echo _tlogger_prompt_command',
    '',
    '   '
  ]
  it.each(evidence)('keeps %j', (cmd) => {
    expect(isCapturePlumbing(cmd)).toBe(false)
  })

  it('ignores a non-string command', () => {
    expect(isCapturePlumbing(undefined)).toBe(false)
    expect(isCapturePlumbing(null)).toBe(false)
    expect(isCapturePlumbing(42)).toBe(false)
  })
})
