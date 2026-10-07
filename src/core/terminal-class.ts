// What happens to a command before it runs: relay its output, give it a PTY,
// or leave it completely alone. Spec 052, research.md D3.
//
// This is a product decision wearing a function's clothes. A PTY-captured
// command cannot be locally suspended, so putting `nc` in the `pty` class
// would silently break the Ctrl-Z / `stty raw -echo` / `fg` upgrade in the
// middle of an engagement (FR-025); relaying `vim` would fill the evidence
// with cursor movements and record none of the file (FR-026). The lists are
// the policy, and they are the operator's to edit.
//
// Pure, and over argv only. Nothing here reads a command's output — that is
// attacker-controlled (FR-002) — and nothing depends on the machine it runs
// on, so RedLog and the shell adapter can reach the same verdict.

import policy from '../../hooks/command-class.json'

export type CommandClass = 'relayed' | 'pty' | 'native'

// The lists live in `hooks/command-class.json`, beside the adapter that also
// reads them (through `hooks/redlog-relay.py`). One list, two readers. A
// second copy of these names here would drift from the shell's, and the drift
// would be silent until the day an operator's reverse shell went through a
// relay mid-engagement — which is the failure the list exists to prevent.
const NATIVE = new Set(policy.native)
const PTY = new Set(policy.pty)
const REPL = new Set(policy.repl)
const REPL_SCRIPT_FLAGS = new Set(policy.replScriptFlags)
const WRAPPERS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(policy.wrappers).map(([name, flags]) => [name, new Set(flags)])
)

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function basename(token: string): string {
  const cut = token.lastIndexOf('/')
  return cut === -1 ? token : token.slice(cut + 1)
}

/** Walk past the wrappers and return where the real command starts. */
function programIndex(argv: string[]): number {
  let i = 0
  while (i < argv.length) {
    const wrapper = WRAPPERS[basename(argv[i])]
    if (!wrapper) break
    i += 1
    while (i < argv.length) {
      const token = argv[i]
      if (token === '--') { i += 1; break }
      if (token.startsWith('-')) { i += wrapper.has(token) ? 2 : 1; continue }
      // `env FOO=bar cmd` — the assignments belong to the wrapper.
      if (ASSIGNMENT.test(token)) { i += 1; continue }
      break
    }
  }
  return i
}

export function classifyCommand(argv: string[]): CommandClass {
  const start = programIndex(argv)
  const program = basename(argv[start] ?? '')
  // Nothing to run. `native` rather than `relayed`, because a bare Enter must
  // not route the shell's own empty prompt through a relay.
  if (program === '') return 'native'

  if (PTY.has(program)) return 'pty'
  if (NATIVE.has(program)) return 'native'
  if (REPL.has(program)) {
    const args = argv.slice(start + 1)
    const given = args.some((a) => REPL_SCRIPT_FLAGS.has(a) || !a.startsWith('-'))
    return given ? 'relayed' : 'native'
  }
  return 'relayed'
}
