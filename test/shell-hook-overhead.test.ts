import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'
import golden from './fixtures/shell-session-golden.json'

// What the shell hooks cost on every Enter, and what they send for it.
//
// The adapters were made cheaper per command: the class answer cached in bash
// as zsh already did, the payload built without python3 on bash 3.2, and the
// recording check, the command id, the identity stamp and the spool count done
// with shell builtins instead of grep, date, find and `$( )`. Each of those is
// a place where the event could quietly change, so this holds two things:
//
//   1. The events. One scripted session — plain commands, quoting, a failure,
//      a non-ASCII line (the python builder), `redlog stop`/`start`, RedLog
//      refusing (spooled), RedLog refusing with no project (dropped, with its
//      notice), and a project switch — is run in zsh and in bash, and every
//      POST body, every spooled file and every `[redlog]` line must equal
//      `fixtures/shell-session-golden.json`. That file was written by this
//      test run against the hooks as they were before the change; only what
//      differs from run to run (times, ids, pids, the temporary directory) is
//      masked.
//   2. The cost. Per trivial command, how many times python3 and curl are
//      started, counted by stand-ins on PATH. An upper bound, not an exact
//      count: what it stops is the per-command python3 coming back.
//
// Driven like an operator's terminal without a PTY: an interactive shell
// reading its lines from stdin, in a throwaway HOME (and ZDOTDIR), with a fake
// curl that keeps each body and exits with the status in a file the session
// can rewrite. Every command it runs is classed native in the overlay, so no
// relay is started. REDLOG_TEST_HOOK_DIR points the shells at another copy of
// the hooks; REDLOG_SESSION_DUMP writes the normalised session to a file, which
// is how the golden file was made.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'

const NATIVE = ['echo', 'printf', 'false', 'true', 'redlog', 'rm', 'mv', 'cd']

const SESSION = [
  'echo plain-one',
  `printf '%s\\n' "quo\\"te" 'and $HOME \`x\`'`,
  'false',
  // Not ASCII: the python builder's event, not the shell's.
  'echo café',
  // A tab in the working directory puts a control character in both events'
  // `cwd`. It used to reach the payload raw, `json.loads` refused it and both
  // events were dropped; it is written as `\t` now, and the events are sent.
  'cd "$TABDIR"',
  'echo in-tab-dir',
  'cd "$WORKDIR"',
  'redlog stop',
  'echo while-stopped',
  'redlog start',
  'printf 7 > "$RCF"; echo goes-to-spool',
  'echo spooled-too',
  'printf 0 > "$RCF"; echo back-again',
  'printf 7 > "$RCF"; mv "$HOME/.redlog/active-identity.json" "$HOME/id.saved"',
  'echo dropped-no-project',
  `printf 0 > "$RCF"; printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"`,
  'echo after-restore',
  `printf '%s' '{"engagementId":"eng-2","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"`,
  'echo after-switch'
]

function script(shell: Shell, lines: string[], counting: boolean): string {
  const shellRun = shell === 'zsh'
    ? `zsh -d -i < "$work/cmds" > "$work/out" 2>&1`
    : `bash --rcfile "$work/bashrc" -i < "$work/cmds" > "$work/out" 2>&1`
  // Stand-ins that log their name and hand over to the real program.
  const shims = counting
    ? `for c in python3 grep date mktemp find wc; do
  real=$(command -v "$c") || continue
  printf '#!/bin/sh\\necho %s >> "$EXECLOG"\\nexec "%s" "$@"\\n' "$c" "$real" > "$work/bin/$c"
  chmod +x "$work/bin/$c"
done`
    : ''
  // A UTF-8 locale, named the way this machine names it: bash 3.2 in the C
  // locale drops the bytes of `café` it reads, so the line recorded would
  // depend on the machine.
  return `set -u
export LC_ALL="$(locale -a 2>/dev/null | grep -i -m1 -E '^(c|en_us)\\.utf-?8$' || echo C)"
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-overhead.XXXXXX")
# TMPDIR ends in a slash on macOS; the shell reports its cwd without the double.
work=$(cd "$work" && pwd)
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" RCF="$work/rc" CAP="$work/cap" EXECLOG="$work/exec"
export WORKDIR="$work" TABDIR="$work/tab	dir"
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin" "$CAP" "$TABDIR"
: > "$EXECLOG"
printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"
printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"
printf '%s' '{"native":${JSON.stringify(NATIVE)}}' > "$HOME/.redlog/command-class.json"
printf 0 > "$RCF"
${shims}
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
echo curl >> "$EXECLOG"
n=$(cat "$CAP.n" 2>/dev/null || echo 1000)
echo $((n + 1)) > "$CAP.n"
cat > "$CAP/$n.json"
exit "$(cat "$RCF")"
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' > "$work/bashrc"
cat > "$work/cmds" <<'CMDS'
${lines.join('\n')}
CMDS
cd "$work"
${shellRun}
echo "@@WORK $work"
echo '@@OUT'; cat "$work/out"
# zsh leaves its last prompt without a newline.
echo; echo '@@END'
for f in $(ls "$CAP" | sort -n); do echo "@@POST $(cat "$CAP/$f")"; done
for f in $(ls "$HOME/.redlog/pending" 2>/dev/null | sort); do
  echo "@@SPOOL $(cat "$HOME/.redlog/pending/$f")"
  echo "@@MODE $(ls -l "$HOME/.redlog/pending/$f" | cut -c1-10)"
done
[ -d "$HOME/.redlog/pending" ] && echo "@@DIRMODE $(ls -ld "$HOME/.redlog/pending" | cut -c1-10)"
echo '@@EXEC'; cat "$EXECLOG"
`
}

interface Session {
  posts: unknown[]
  spool: unknown[]
  modes: string[]
  notices: string[]
  exec: string[]
  raw: string
}

/** Masks what differs between two runs of the same session, and nothing else.
 *  Ids keep their identity: the first id seen is C1 wherever it appears, so a
 *  command_end that names another command's id still shows. */
function normalise(text: string, work: string, ids: Map<string, string>): unknown {
  const value = JSON.parse(text)
  const id = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    if (!ids.has(v)) ids.set(v, `C${ids.size + 1}`)
    return ids.get(v)
  }
  const data = value.data ?? {}
  for (const k of ['source_timestamp', 'pid', 'duration_sec']) if (k in data) data[k] = `<${k}>`
  for (const k of ['command_id', 'session_id', 'terminalId']) if (k in data) data[k] = id(data[k])
  return JSON.parse(JSON.stringify(value).split(work).join('$WORK'))
}

async function runSession(shell: Shell, lines: string[], counting = false): Promise<Session> {
  const r = await runInShell(target!, script(shell, lines, counting), { timeoutMs: 120_000 })
  const out = r.stdout
  const work = /^@@WORK (.*)$/m.exec(out)?.[1]
  expect(work, `harness did not finish: ${r.stderr.slice(0, 400)}`).toBeTruthy()
  const ids = new Map<string, string>()
  const lineOf = (tag: string): string[] =>
    out.split('\n').filter((l) => l.startsWith(`@@${tag} `)).map((l) => l.slice(tag.length + 3))
  const transcript = out.slice(out.indexOf('@@OUT\n') + 6, out.indexOf('\n@@END\n'))
  return {
    posts: lineOf('POST').map((t) => normalise(t, work!, ids)),
    spool: lineOf('SPOOL').map((t) => normalise(t, work!, ids)),
    modes: [...lineOf('MODE'), ...lineOf('DIRMODE')],
    // zsh draws `%` and a carriage return ahead of each prompt: what follows
    // the last `\r` is what the operator reads on that line.
    notices: transcript.split('\n').map((l) => l.split('\r').pop()!)
      .filter((l) => l.startsWith('[redlog]')),
    exec: out.slice(out.indexOf('@@EXEC\n') + 7).split('\n').filter(Boolean),
    raw: out + r.stderr
  }
}

// The spool count was `find DIR -maxdepth 1 -name '*.json' | wc -l`; it is a
// glob now, and a glob answers to the operator's options. So: a dot file
// counts (find counted it), `X.JSON` does not (find is case-sensitive), and
// the operator's own case-insensitive globbing is on throughout and still on
// afterwards.
describeShell('the spool cap counts what find counted', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    it(`${shell}: 5000 waiting stops the next event, 4999 lets it in, and no glob option leaks`, async () => {
      const setOpt = shell === 'zsh' ? 'setopt nocaseglob' : 'shopt -s nocaseglob'
      const showOpt = shell === 'zsh' ? '[[ -o nocaseglob ]] && echo OPT-KEPT' : 'shopt -q nocaseglob && echo OPT-KEPT'
      const run = await runInShell(target!, `
set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-cap.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home/pending"
printf '#!/bin/sh\\ncat >/dev/null\\nexit 7\\n' > "$work/bin/curl"; chmod +x "$work/bin/curl"
printf 1 > "$work/home/api-port"; printf t > "$work/home/api-token"
printf '{"engagementId":"eng-1","operatorId":"op-1"}' > "$work/home/active-identity.json"
i=0; while [ $i -lt 4998 ]; do : > "$work/home/pending/$i.json"; i=$((i + 1)); done
: > "$work/home/pending/.hidden.json"; : > "$work/home/pending/UPPER.JSON"
cat > "$work/s" <<EOF
export PATH="$work/bin:\\$PATH" _REDLOG_DIR="$work/home" _REDLOG_HOST=127.0.0.1
unset WSL_DISTRO_NAME REDLOG_TERMINAL REDLOG_EXTERNAL_SESSION
source ${JSON.stringify(path.join(hookDir(), 'shell-common.sh'))}
${setOpt}
_redlog_send_event command_start one
_redlog_send_event command_start two
${showOpt}
EOF
${shell === 'zsh' ? 'zsh -f' : 'bash --norc'} "$work/s"
echo "WAITING=$(find "$work/home/pending" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
`, { timeoutMs: 120_000 })
      // 4998 + the dot file is 4999: the first event makes 5000, the second is refused.
      expect(run.stdout, run.stderr.slice(0, 400)).toContain('WAITING=5000')
      expect(run.stdout).toContain('OPT-KEPT')
    }, 150_000)
  }
})

describeShell('the shell hooks per command', () => {
  const sessions: Partial<Record<Shell, Session>> = {}

  beforeAll(async () => {
    for (const shell of ['zsh', 'bash'] as const) sessions[shell] = await runSession(shell, SESSION)
    const dump = process.env.REDLOG_SESSION_DUMP
    if (dump) {
      const strip = (s: Session): Omit<Session, 'raw' | 'exec'> =>
        ({ posts: s.posts, spool: s.spool, modes: s.modes, notices: s.notices })
      fs.writeFileSync(dump, JSON.stringify({ zsh: strip(sessions.zsh!), bash: strip(sessions.bash!) }, null, 2) + '\n')
    }
  }, 300_000)

  for (const shell of ['zsh', 'bash'] as const) {
    describe(shell, () => {
      it('sends the events it sent before, in the same order, with the same fields', () => {
        const s = sessions[shell]!
        expect(s.posts.length, s.raw.slice(-1500)).toBeGreaterThan(10)
        expect(s.posts).toEqual(golden[shell].posts)
      })

      it('spools the same files, owner-only, and says the same things', () => {
        const s = sessions[shell]!
        expect(s.spool.length, 'the session spools nothing, so this compares nothing').toBeGreaterThan(0)
        expect(s.spool).toEqual(golden[shell].spool)
        expect(s.modes).toEqual(golden[shell].modes)
        expect(s.notices).toEqual(golden[shell].notices)
      })

      it('starts no python3 for a command it has classified, and at most two curls a command', async () => {
        const warm = ['true', 'true']
        const steady = Array.from({ length: 12 }, () => 'true')
        // A marker between the two halves: everything after it is steady state.
        const s = await runSession(shell, [...warm, 'echo mark >> "$EXECLOG"', ...steady], true)
        const after = s.exec.slice(s.exec.findIndex((l) => l.startsWith('mark')) + 1)
        expect(after.length, s.raw.slice(-800)).toBeGreaterThan(0)
        const count = (name: string): number => after.filter((l) => l === name).length
        // The marker line itself is new to the class cache: one classify at most.
        expect(count('python3'), after.join(' ')).toBeLessThanOrEqual(1)
        expect(count('curl')).toBeLessThanOrEqual(2 * (steady.length + 1))
        // The recording check, the spool count and the temporary directories
        // are the shell's own now; a grep, find, wc or mktemp per command is
        // the regression.
        for (const name of ['grep', 'wc', 'mktemp']) expect(count(name), name).toBe(0)
        // One `find` is the relay-directory sweep the hook starts behind the
        // first prompt, once per shell, which can land after the marker.
        expect(count('find'), 'find').toBeLessThanOrEqual(1)
      }, 120_000)
    })
  }
})
