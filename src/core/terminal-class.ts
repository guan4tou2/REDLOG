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

export type CommandClass = 'relayed' | 'pty' | 'native'

/** Leave it alone entirely: it owns the terminal and recording it either
 *  breaks it or records redraws. */
const NATIVE = new Set([
  'nc', 'ncat',                              // FR-025: must stay suspendable
  'vim', 'vi', 'nvim', 'nano', 'emacs',      // FR-026: redraws, not content
  'less', 'more'
])

/** Brings its own TTY, so a PTY capture is lossless and the suspension cost
 *  is one the operator accepts for these. */
const PTY = new Set(['ssh', 'socat', 'pwncat-cs'])

/** Interactive when bare, an ordinary command when handed something to run. */
const REPL = new Set([
  'python', 'python2', 'python3', 'ipython',
  'node', 'irb', 'ruby', 'perl', 'php', 'lua'
])

/** `-c`, `-m`, `-e`: the flags that turn a REPL into a command with output. */
const REPL_SCRIPT_FLAGS = new Set(['-c', '-m', '-e'])

/** Wrappers that stand in front of the real command. Classifying on the first
 *  word would put `sudo nc` in the relayed class and break the upgrade just as
 *  surely as classifying `nc` wrong would. FR-027. */
const WRAPPERS: Record<string, Set<string>> = {
  // name → flags that take a separate value, so the value is not mistaken
  // for the wrapped command.
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S']),
  proxychains: new Set(['-f']),
  proxychains4: new Set(['-f'])
}

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
