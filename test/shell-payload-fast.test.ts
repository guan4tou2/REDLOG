import { describe, it, expect, beforeAll } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #288. `_redlog_send_event` used to start python3 to build every payload, ~40 ms
// on each of the two events a command sends. Plain events are now written by
// the shell itself, and anything it cannot be sure of is handed to the python
// builder that has always been the reference.
//
// So this is not a test of the fast builder alone. It holds the whole of
// `_redlog_send_event` to ONE output: the same event is sent once with the
// python builder forced and once without, into two homes with nothing listening
// (so each is spooled to disk), and the parsed JSON must be identical — in bash
// and in zsh, which expand `${s//\\/\\\\}` and its cousins in ways that are
// close enough to be wrong quietly. The other half is that the fast builder
// DECLINES what it should: a corpus that all fell through to python would pass
// the first half and speed up nothing.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

interface Case {
  name: string
  command: string
  extra?: string
  /** active-identity.json, written into both homes. */
  identity?: string
  env?: Record<string, string>
  /** Whether the fast builder should take it (rc 0) or hand it back (rc 1). */
  fast: boolean
}

const BIG = 'x'.repeat(40_000)

const CASES: Case[] = [
  { name: 'a plain command', command: 'ls -la /tmp', fast: true },
  { name: 'an empty command', command: '', fast: true },
  { name: 'double quotes', command: 'echo "hi there"', fast: true },
  { name: 'single quotes', command: "echo 'it works'", fast: true },
  { name: 'backslashes, as typed', command: 'printf "%s\\n" a\\ b \\\\', fast: true },
  { name: 'a quote after a backslash', command: 'echo \\"x\\"', fast: true },
  { name: 'JSON-looking text', command: 'echo \'{"a":[1,2],"b":"c"}\'', fast: true },
  { name: 'a dollar, a backtick, a percent', command: 'echo $HOME `id` 100%', fast: true },
  { name: 'every printable ASCII character', command: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~', fast: true },
  { name: 'a command that is only spaces', command: '   ', fast: true },

  { name: 'extra with the usual fields', command: 'nmap -sV 10.0.0.5', extra: '{"cwd":"/home/op/work","command_id":"17-4-9","class":"relayed","source":"auto-relay"}', fast: true },
  { name: 'extra with spaces around it and inside', command: 'id', extra: '  { "a" : 1 , "b" : "two" }  ', fast: true },
  { name: 'extra that is an empty object', command: 'id', extra: '{}', fast: true },
  { name: 'extra that is only whitespace', command: 'id', extra: '   ', fast: true },
  { name: 'extra that overrides a base field', command: 'id', extra: '{"shell":"override","source":"auto-relay","pid":1}', fast: true },
  { name: 'extra holding non-ASCII', command: 'id', extra: '{"cwd":"/tmp/日本語"}', fast: true },
  { name: 'extra holding escapes', command: 'id', extra: '{"stdout":"a\\nb\\t\\"c\\" \\u00e9"}', fast: true },

  { name: 'a non-ASCII command', command: '日本語 --help', fast: false },
  { name: 'an accented command', command: 'echo café', fast: false },
  { name: 'a tab in the command', command: 'echo a\tb', fast: false },
  { name: 'a newline in the command', command: 'echo a\necho b', fast: false },
  { name: 'a command over the size the shell will handle', command: BIG, fast: false },
  { name: 'extra with a newline in it', command: 'id', extra: '{\n  "a": 1\n}', fast: false },
  { name: 'extra that is not an object', command: 'id', extra: '[1,2]', fast: false },
  { name: 'extra cut off', command: 'id', extra: '{"a":', fast: false },
  { name: 'extra over the size the shell will handle', command: 'id', extra: `{"stdout":"${BIG}"}`, fast: false },

  { name: 'a flat identity', command: 'whoami', identity: '{"engagementId":"eng-1","operatorId":"op-1"}', fast: true },
  { name: 'a pretty-printed flat identity', command: 'whoami', identity: '{\n  "engagementId": "eng-1",\n  "operatorId": "op-1"\n}\n', fast: true },
  { name: 'an identity with no engagement', command: 'whoami', identity: '{"operatorId":"op-1"}', fast: true },
  { name: 'a nested identity', command: 'whoami', identity: '{"engagementId":"eng-1","meta":{"a":1}}', fast: false },
  { name: 'an identity cut off mid-write', command: 'whoami', identity: '{"engagementId":"eng-1","oper', fast: false },
  { name: 'an identity that names an engagement but is not an object', command: 'whoami', identity: '"engagementId" eng-1', fast: false },
  { name: 'an identity that is not JSON and names nothing', command: 'whoami', identity: 'garbage', fast: true },
  { name: 'an identity with non-ASCII in it', command: 'whoami', identity: '{"engagementId":"eng-1","operatorId":"操作員"}', fast: false },

  { name: 'a built-in terminal', command: 'ls', identity: '{"engagementId":"builtin-project","operatorId":"op-1"}', env: { REDLOG_TERMINAL: '1', REDLOG_TERMINAL_ID: 'term-7' }, fast: true },
  { name: 'WSL distro identity', command: 'id', env: { WSL_DISTRO_NAME: 'Ubuntu' }, fast: true },
  { name: 'a terminal id that needs escaping', command: 'ls', env: { REDLOG_TERMINAL_ID: 'a"b\\c' }, fast: true },
  { name: 'a terminal id that is not ASCII', command: 'ls', env: { REDLOG_TERMINAL_ID: 'ターミナル' }, fast: false },
  { name: 'a shell name that needs escaping', command: 'ls', env: { SHELL: '/bin/we"ird' }, fast: true }
]

/** Spooling needs a project identity (a payload without one is never replayed),
 *  so a case that does not test the identity itself runs inside a project. */
const DEFAULT_IDENTITY = '{"engagementId":"eng-1","operatorId":"op-1"}'

/** A string as one single-quoted word, whatever is in it. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function body(hook: string): string {
  const lines: string[] = []
  CASES.forEach((c, i) => {
    const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`).join(' ')
    lines.push(`run_case ${i} ${shq(c.command)} ${shq(c.extra ?? '')} ${shq(c.identity ?? DEFAULT_IDENTITY)} ${shq(env)}`)
  })
  return `
if [ -n "\${ZSH_VERSION:-}" ]; then zmodload zsh/datetime 2>/dev/null; fi
echo "CLOCK \${EPOCHREALTIME:+available}"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID
export SHELL=\${SHELL:-/bin/sh}
. ${hook}
# Payload-only fixture: an explicitly resolved offline directory, including WSL.
_redlog_is_running() { export _REDLOG_DIR="$HOME/.redlog"; return 1; }
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

run_case() {
  local i="$1" cmd="$2" extra="$3" ident="$4" envs="$5"
  local side
  for side in py fast; do
    mkdir -p "$W/$side$i/.redlog"
    if [ -n "$ident" ]; then printf '%s' "$ident" > "$W/$side$i/.redlog/active-identity.json"; fi
  done
  # What the fast builder says on its own, with the python home's identity.
  local probe="$W/probe$i"
  ( export HOME="$W/fast$i"; if [ -n "$envs" ]; then eval "export $envs"; fi
    _redlog_build_payload_fast command_start "$cmd" "$extra" "$probe" ; echo "RC $i $?" )
  ( export HOME="$W/py$i"; if [ -n "$envs" ]; then eval "export $envs"; fi
    REDLOG_PAYLOAD_BUILDER=python _redlog_send_event command_start "$cmd" "$extra" )
  ( export HOME="$W/fast$i"; if [ -n "$envs" ]; then eval "export $envs"; fi
    _redlog_send_event command_start "$cmd" "$extra" )
}

${lines.join('\n')}

python3 - "$W" ${CASES.length} <<'PY'
import glob, json, os, sys
w, n = sys.argv[1], int(sys.argv[2])
out = {}
for i in range(n):
    row = {}
    for side in ('py', 'fast'):
        found = []
        for f in sorted(glob.glob(os.path.join(w, side + str(i), '.redlog', 'pending', '*.json'))):
            raw = open(f, encoding='utf-8').read()
            try:
                d = json.loads(raw)
            except ValueError:
                # Not JSON: a failure of THIS case, not of the whole run.
                found.append({'unparseable': raw[:200]})
                continue
            # When the command ran. Two builders run a few milliseconds apart.
            d.get('data', {}).pop('source_timestamp', None)
            found.append(d)
        row[side] = found
    out[i] = row
print('DUMP ' + json.dumps(out))
PY
`
}

interface Result { preciseClock: boolean; rc: Record<number, number>; dump: Record<string, { py: unknown[]; fast: unknown[] }> }

async function runUnder(shell: 'bash' | 'zsh'): Promise<Result> {
  const hook = hookPath(target!, 'shell-common.sh')
  // One script text, written to a file on the shell's side and run by each
  // shell in turn. A heredoc, so nothing in it is expanded on the way.
  const script = `
set -u
S=$(mktemp)
cat > "$S" <<'REDLOG_EOF'
${body(hook)}
REDLOG_EOF
${shell === 'zsh' ? 'zsh -f' : 'bash --norc'} "$S"
rm -f "$S"
`
  const run = await runInShell(target!, script, { timeoutMs: 180_000 })
  const rc: Record<number, number> = {}
  for (const m of run.stdout.matchAll(/^RC (\d+) (\d+)$/gm)) rc[Number(m[1])] = Number(m[2])
  const dumpLine = run.stdout.split('\n').find((l) => l.startsWith('DUMP '))
  if (!dumpLine) throw new Error(`${shell}: no DUMP line.\nstdout: ${run.stdout.slice(0, 400)}\nstderr: ${run.stderr.slice(0, 600)}`)
  return { preciseClock: /^CLOCK available$/m.test(run.stdout), rc, dump: JSON.parse(dumpLine.slice(5)) }
}

describeShell('the shell-built event payload', () => {
  const results: Partial<Record<'bash' | 'zsh', Result>> = {}

  beforeAll(async () => {
    results.bash = await runUnder('bash')
    results.zsh = await runUnder('zsh')
  }, 400_000)

  for (const shell of ['bash', 'zsh'] as const) {
    describe(shell, () => {
      CASES.forEach((c, i) => {
        it(`${c.name}: the same event either way`, () => {
          const { py, fast } = results[shell]!.dump[String(i)]
          // Sent, in both homes — or dropped, in both.
          expect(fast).toEqual(py)
          if (c.env?.WSL_DISTRO_NAME) {
            expect(fast).toHaveLength(1)
            expect((fast[0] as { data: { wsl_distro: string } }).data.wsl_distro).toBe(c.env.WSL_DISTRO_NAME)
          }
        })

        it(`${c.name}: ${c.fast ? 'is built by the shell' : 'is handed to python'}`, () => {
          // macOS ships Bash 3 without EPOCHREALTIME. Declining every fast
          // payload there is intentional; the Python path above must still
          // produce every event. Bash 5 and zsh retain all fast-path checks.
          const shouldBuild = c.fast && results[shell]!.preciseClock
          expect(results[shell]!.rc[i], 'return status of the fast builder').toBe(shouldBuild ? 0 : 1)
        })
      })

      it('actually sent something for the ordinary cases (the comparison is not of two empties)', () => {
        const { py, fast } = results[shell]!.dump['0']
        expect(py).toHaveLength(1)
        expect(fast).toHaveLength(1)
        expect((fast[0] as { data: { command: string } }).data.command).toBe('ls -la /tmp')
      })
    })
  }
})
