import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'

// A working directory is the operator's to name, and the adapters splice it
// into each event's `extra` by hand. Only a double quote used to be escaped, so
// a directory with a tab, a newline or a backslash in its name made `extra`
// invalid JSON: the python builder's `json.loads` refused it and both events of
// every command run there were dropped without a word.
//
// Each case is a directory the shell `cd`s into before one command. Both of
// that command's events must arrive, as valid UTF-8 JSON, carrying the
// directory's name. A name that is not UTF-8 arrives with U+FFFD for the bad
// sequence (the decision `_redlog_build_payload_fast` documents): sent, not
// dropped, and the body is still text.
//
// Run with each builder: the default (the shell builds what it can) and
// REDLOG_PAYLOAD_BUILDER=python, which forces the python builder for every
// event. Driven like `shell-hook-overhead.test.ts`: an interactive shell
// reading its commands from stdin, in a throwaway HOME, with a fake curl that
// keeps each body. REDLOG_TEST_HOOK_DIR points the shells at another copy of
// the hooks.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'
type Builder = 'auto' | 'python'

/** The directory as bash's `$'…'` writes it, and the name RedLog should receive. */
const DIRS: Array<{ name: string; shell: string; expected: string }> = [
  { name: 'a tab', shell: `$'tab\\there'`, expected: 'tab\there' },
  { name: 'a newline', shell: `$'nl\\nhere'`, expected: 'nl\nhere' },
  { name: 'a carriage return and other C0 controls', shell: `$'cr\\r\\x01\\x1f-x'`, expected: 'cr\r\u0001\u001f-x' },
  { name: 'a double quote', shell: `'q"uote'`, expected: 'q"uote' },
  { name: 'a backslash', shell: `'back\\slash'`, expected: 'back\\slash' },
  { name: 'a backslash before a quote', shell: `'b\\"q'`, expected: 'b\\"q' },
  { name: 'non-ASCII', shell: `'日本語-café'`, expected: '日本語-café' },
  { name: 'an invalid UTF-8 byte', shell: `$'bad\\xffname'`, expected: 'bad�name' },
  { name: 'a truncated UTF-8 sequence', shell: `$'cut\\xe6\\x97'`, expected: 'cut�' }
]

interface Ev { subtype: string; command: string; cwd: string | null }
interface Run { events: Ev[]; bad: string[]; fakePwd: number[]; raw: string }

function script(shell: Shell, builder: Builder): string {
  const shellRun = shell === 'zsh'
    ? `zsh -d -i < "$work/cmds" > "$work/out" 2>&1`
    : `bash --rcfile "$work/bashrc" -i < "$work/cmds" > "$work/out" 2>&1`
  // APFS refuses a name that is not UTF-8 (EILSEQ), so on macOS those cases
  // cannot be a real directory. There the shell is given the name as `PWD`
  // instead, which is the variable the adapters read; `cd` puts it back. The
  // run says which it did (`@@FAKEPWD`).
  const mk = DIRS.map((d, i) =>
    `D${i}="$work/"${d.shell}; if mkdir -p "$D${i}" 2>/dev/null; then C${i}='cd "$D${i}"'; else C${i}='PWD=$D${i}'; echo "@@FAKEPWD ${i}"; fi; export D${i}`
  ).join('\n')
  const cmds = DIRS.map((_, i) => `$C${i}\necho at-${i}\ncd "$WORKDIR"`).join('\n')
  return `set -u
export LC_ALL="$(locale -a 2>/dev/null | grep -i -m1 -E '^(c|en_us)\\.utf-?8$' || echo C)"
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-cwd.XXXXXX")
work=$(cd "$work" && pwd)
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" CAP="$work/cap" WORKDIR="$work"
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin" "$CAP"
printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"
printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"
printf '%s' '{"native":["echo","cd","redlog"]}' > "$HOME/.redlog/command-class.json"
${mk}
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
n=$(cat "$CAP.n" 2>/dev/null || echo 1000)
echo $((n + 1)) > "$CAP.n"
cat > "$CAP/$n.json"
exit 0
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
${builder === 'python' ? 'export REDLOG_PAYLOAD_BUILDER=python' : ''}
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' > "$work/bashrc"
# Unquoted: each \`$Cn\` becomes the line that enters case n.
cat > "$work/cmds" <<CMDS
${cmds}
CMDS
cd "$work"
${shellRun}
echo '@@OUT'; cat "$work/out"; echo
python3 - "$CAP" <<'PY'
import json, os, sys
cap = sys.argv[1]
for name in sorted(os.listdir(cap), key=lambda n: int(n.split('.')[0])):
    raw = open(os.path.join(cap, name), 'rb').read()
    try:
        data = json.loads(raw.decode('utf-8'))['data']
    except Exception as e:
        print('@@BAD ' + json.dumps(repr(raw[:300])))
        continue
    print('@@EV ' + json.dumps({'subtype': data.get('subtype'), 'command': data.get('command'), 'cwd': data.get('cwd')}))
PY
`
}

async function run(shell: Shell, builder: Builder): Promise<Run> {
  const r = await runInShell(target!, script(shell, builder), { timeoutMs: 120_000 })
  const lines = r.stdout.split('\n')
  return {
    events: lines.filter((l) => l.startsWith('@@EV ')).map((l) => JSON.parse(l.slice(5)) as Ev),
    bad: lines.filter((l) => l.startsWith('@@BAD ')),
    fakePwd: lines.filter((l) => l.startsWith('@@FAKEPWD ')).map((l) => Number(l.slice(10))),
    raw: (r.stdout + r.stderr).slice(-3000)
  }
}

// The same decision for the strings the python builder takes as arguments and
// from the environment: a command, and a terminal id, that are not UTF-8. They
// reach python as lone surrogates, which json.dumps writes as `\udcff`: valid
// JSON syntax, but not text, and not what the same bytes in `cwd` become.
describeShell('a command or terminal id that is not UTF-8', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    it(`${shell}: is sent with U+FFFD for the bad sequence`, async () => {
      const common = path.join(hookDir(), 'shell-common.sh')
      const r = await runInShell(target!, `
set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-argv.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/.redlog"
printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$work/.redlog/active-identity.json"
cat > "$work/s" <<EOF
export HOME="$work" _REDLOG_DIR="$work/.redlog" REDLOG_PAYLOAD_BUILDER=python REDLOG_TERMINAL_ID=\\$(printf 'term\\\\377id')
unset WSL_DISTRO_NAME REDLOG_TERMINAL REDLOG_EXTERNAL_SESSION
source ${JSON.stringify(common)}
_redlog_is_running() { return 1; }
_redlog_send_event command_start "\\$(printf 'echo \\\\377x')" '{}'
EOF
${shell === 'zsh' ? 'zsh -f' : 'bash --norc'} "$work/s"
python3 - "$work/.redlog/pending" <<'PY'
import json, os, sys
for name in sorted(os.listdir(sys.argv[1])):
    data = json.loads(open(os.path.join(sys.argv[1], name), 'rb').read().decode('utf-8'))['data']
    print('@@EV ' + json.dumps({'command': data['command'], 'terminalId': data['terminalId']}))
PY
`, { timeoutMs: 60_000 })
      const ev = r.stdout.split('\n').filter((l) => l.startsWith('@@EV ')).map((l) => JSON.parse(l.slice(5)))
      expect(ev, r.stdout + r.stderr).toEqual([{ command: 'echo �x', terminalId: 'term�id' }])
    }, 90_000)
  }
})

// A relayed command's command_end is built by the relay from `--cwd`, not by
// the shell. The same bytes must become the same text there.
describeShell('the relay names a working directory that is not UTF-8 the same way', () => {
  it('finish writes U+FFFD for the bad sequence', async () => {
    const relay = path.join(hookDir(), 'redlog-relay.py')
    const r = await runInShell(target!, `
set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-relaycwd.XXXXXX")
trap 'rm -rf "$work"' EXIT
python3 ${JSON.stringify(relay)} finish --stdout-part "$work/no-out" --stderr-part "$work/no-err" \\
  --drain-timeout 0 --command-id cid --cwd "$(printf '/x/bad\\377dir')" > "$work/ev"
python3 -c 'import json, sys; print("@@CWD " + json.dumps(json.loads(open(sys.argv[1], "rb").read().decode("utf-8"))["cwd"]))' "$work/ev"
`, { timeoutMs: 60_000 })
    const line = r.stdout.split('\n').find((l) => l.startsWith('@@CWD '))
    expect(line, r.stdout + r.stderr).toBeTruthy()
    expect(JSON.parse(line!.slice(6))).toBe('/x/bad�dir')
  }, 90_000)
})

describeShell('a working directory with any name is sent, not dropped', () => {
  const runs: Partial<Record<`${Shell}-${Builder}`, Run>> = {}

  beforeAll(async () => {
    for (const shell of ['zsh', 'bash'] as const) {
      for (const builder of ['auto', 'python'] as const) runs[`${shell}-${builder}`] = await run(shell, builder)
    }
  }, 400_000)

  for (const shell of ['zsh', 'bash'] as const) {
    for (const builder of ['auto', 'python'] as const) {
      describe(`${shell}, ${builder} builder`, () => {
        it('every body is valid UTF-8 JSON', () => {
          const r = runs[`${shell}-${builder}`]!
          expect(r.events.length, r.raw).toBeGreaterThan(DIRS.length * 2)
          expect(r.bad, r.raw).toEqual([])
          // Only a name that is not UTF-8 may need the stand-in.
          for (const i of r.fakePwd) expect(DIRS[i].expected).toContain('�')
        })

        DIRS.forEach((d, i) => {
          it(`${d.name}: both events of a command run there arrive, naming it`, () => {
            const r = runs[`${shell}-${builder}`]!
            const mine = r.events.filter((e) => e.command === `echo at-${i}`)
            expect(mine.map((e) => e.subtype), r.raw).toEqual(['command_start', 'command_end'])
            for (const e of mine) expect(e.cwd!.split('/').pop()).toBe(d.expected)
          })
        })
      })
    }
  }
})
