import { spawnSync } from 'child_process'

// Whether the `bash` on PATH can do what the bash hook's trap chaining needs,
// asked the way the hook asks it: from a prompt command, read the DEBUG trap
// through `$( )`, then set another over it and read that back.
//
// Not a version check. Bash 5.x passes; the macOS runner's bash did not chain,
// and what separates them is behaviour, not a number a test can be sure of.
// Where this is false the hook installs its own trap once and does not touch
// another tool's, and the chaining cases skip instead of failing.
function probe(): boolean {
  if (process.platform === 'win32') return false
  const script = [
    `PROMPT_COMMAND='_seen=$(trap -p DEBUG); trap -- ": probe-two" DEBUG; _after=$(trap -p DEBUG)'`,
    `trap ':' DEBUG`,
    // `$((1))` so the echoed line is not mistaken for the answer.
    `[[ -n "$_seen" && "$_after" == *probe-two* ]] && echo "PROBE<$((1))>"`,
    'exit'
  ].join('\n')
  const r = spawnSync('bash', ['--norc', '-i'], { input: script, encoding: 'utf8' })
  return /PROBE<1>/.test(r.stdout)
}

export const bashCanChainDebugTrap: boolean = probe()
