import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'

// `~/.redlog/terminal-app` restricts recording to one terminal application
// (spec 062 T086, spec 064 T003). Only hooks/terminal_app.py can attest which
// application a shell runs in: it walks the process ancestry with `ps`.
//
// Both adapters unset `_redlog_adapter_dir` right after sourcing
// shell-common.sh, and the gate then ran `python3 "/terminal_app.py"`, which
// always failed — so naming any application refused every terminal, the named
// one included. And the attestation, ~19 ms of python3, ran again at every
// command and every send.
//
// What it should do: load and record in the named application, refuse
// elsewhere and say why once, leave a machine with no selection (or `all`)
// alone, and ask the resolver at most once per shell.
//
// `ps` is not something a test can steer, and a sandbox may forbid it. So a
// `python3` on PATH stands in for the interpreter when, and only when, it is
// asked to run terminal_app.py: it imports the module from the directory the
// hook named and replaces `terminal_origin` with FAKE_ORIGIN, then runs the
// module's own entry point. Everything else about the decision is the real
// module's. A helper path that does not exist fails exactly as python would.
// Every such call is logged, which is how the once-per-shell rule is measured.
// Every other python3 call goes to the real interpreter untouched.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'

// Loading prints nothing (test/shell-quiet-init.test.ts); that the adapter
// loaded is shown by the commands it records.
const REFUSED = '[redlog] this terminal is not recorded — RedLog is set to record only in'

interface Scenario {
  shell: Shell
  /** Contents of ~/.redlog/terminal-app, or null for no file. */
  selection: string | null
  /** What the OS would attest this terminal to be. */
  origin: string
  commands: string[]
}

interface Outcome { transcript: string; commands: string[]; attestations: number; raw: string }

const FAKE_TA = `import os, sys
path = sys.argv[1]
if not os.path.isfile(path):
    sys.stderr.write("python3: can't open file %r\\n" % path)
    sys.exit(2)
sys.path.insert(0, os.path.dirname(path))
import terminal_app
origin = os.environ.get('FAKE_ORIGIN') or None
terminal_app.terminal_origin = lambda: origin
if hasattr(terminal_app, 'main'):
    sys.exit(terminal_app.main(sys.argv[2:]))
sys.exit(0 if terminal_app.terminal_app_allowed(sys.argv[2] if len(sys.argv) > 2 else None) else 1)
`

function script(s: Scenario): string {
  const shellRun = s.shell === 'zsh'
    ? `zsh -d -i < "$work/cmds" > "$work/out" 2>&1`
    : `bash --rcfile "$work/bashrc" -i < "$work/cmds" > "$work/out" 2>&1`
  return `set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-termapp.XXXXXX")
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" RCF="$work/rc" TALOG="$work/ta.log" FAKE_ORIGIN=${JSON.stringify(s.origin)}
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin"
printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"
printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"
printf '%s' '{"native":["echo","printf","redlog"]}' > "$HOME/.redlog/command-class.json"
${s.selection === null ? '' : `printf '%s\\n' ${JSON.stringify(s.selection)} > "$HOME/.redlog/terminal-app"`}
: > "$TALOG"
REALPY=$(command -v python3)
cat > "$work/fake_ta.py" <<'PY'
${FAKE_TA}PY
cat > "$work/bin/python3" <<FAKE
#!/bin/sh
case "\\$1" in
  */terminal_app.py) echo "terminal_app \\$*" >> "\\$TALOG"; exec "$REALPY" "$work/fake_ta.py" "\\$@" ;;
esac
exec "$REALPY" "\\$@"
FAKE
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
{ cat; echo; } >> "$RCF.posts" 2>/dev/null
exit 0
FAKE
chmod +x "$work/bin/python3" "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' > "$work/bashrc"
cat > "$work/cmds" <<'CMDS'
${s.commands.join('\n')}
CMDS
: > "$RCF.posts"
${shellRun}
echo '@@OUT'; cat "$work/out"
echo '@@POSTS'; cat "$RCF.posts"
echo '@@TALOG'; cat "$TALOG"
echo '@@END'
`
}

const between = (text: string, start: string, end: string): string => {
  const a = text.indexOf(start)
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0)
  return text.slice(a + start.length, text.indexOf(end, a))
}

async function run(s: Scenario): Promise<Outcome> {
  const r = await runInShell(target!, script(s), { timeoutMs: 90_000 })
  const raw = (r.stdout + r.stderr).slice(-3000)
  const commands = between(r.stdout, '@@POSTS\n', '@@TALOG').split('\n').filter((l) => l.trim())
    .map((l) => { const d = JSON.parse(l) as { data: Record<string, unknown> }; return `${String(d.data.subtype)} ${String(d.data.command ?? '')}` })
  const attestations = between(r.stdout, '@@TALOG\n', '@@END').split('\n').filter((l) => l.startsWith('terminal_app ')).length
  return { transcript: between(r.stdout, '@@OUT\n', '@@POSTS'), commands, attestations, raw }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1
const THREE = ['echo one', 'echo two', 'echo three']

describeShell('a terminal-app selection records in that app only', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    describe(shell, () => {
      it('the named app: loads, records every command, and attests once', async () => {
        const o = await run({ shell, selection: 'Apple_Terminal', origin: 'Apple_Terminal', commands: THREE })
        expect(o.transcript, o.raw).not.toContain(REFUSED)
        for (const c of THREE) {
          expect(o.commands, o.raw).toContain(`command_start ${c}`)
          expect(o.commands).toContain(`command_end ${c}`)
        }
        expect(o.attestations, o.raw).toBe(1)
      }, 120_000)

      it('another app: does not load, sends nothing, and says why in one line', async () => {
        const o = await run({ shell, selection: 'Apple_Terminal', origin: 'iTerm.app', commands: THREE })
        expect(count(o.transcript, REFUSED), o.raw).toBe(1)
        expect(o.transcript).toContain(`${REFUSED} Apple_Terminal`)
        expect(o.commands).toEqual([])
        expect(o.attestations, o.raw).toBe(1)
      }, 120_000)

      it('RedLog\'s own pane satisfies any named app', async () => {
        const o = await run({ shell, selection: 'iTerm.app', origin: 'builtin', commands: ['echo pane'] })
        expect(o.transcript, o.raw).not.toContain(REFUSED)
        expect(o.commands).toContain('command_start echo pane')
      }, 120_000)

      it('a selection it does not know is refused, even in RedLog\'s own pane', async () => {
        const o = await run({ shell, selection: 'broken', origin: 'builtin', commands: ['echo x'] })
        expect(count(o.transcript, REFUSED), o.raw).toBe(1)
        expect(o.commands).toEqual([])
      }, 120_000)

      it('narrowed after load: stops at the next command, without asking again', async () => {
        const o = await run({
          shell, selection: 'Apple_Terminal', origin: 'Apple_Terminal',
          commands: ['echo before', `printf 'WindowsTerminal\\n' > "$HOME/.redlog/terminal-app"`, 'echo after-narrow', 'echo still-after']
        })
        expect(o.commands, o.raw).toContain('command_start echo before')
        expect(o.commands.filter((c) => c.includes('after-narrow') || c.includes('still-after')), o.raw).toEqual([])
        expect(o.attestations, o.raw).toBe(1)
      }, 120_000)

      for (const selection of [null, 'all'] as const) {
        it(`${selection === null ? 'no selection file' : '`all`'}: records as before and never asks`, async () => {
          const o = await run({ shell, selection, origin: 'iTerm.app', commands: THREE })
          expect(o.transcript, o.raw).not.toContain(REFUSED)
          expect(o.commands).toContain('command_end echo three')
          expect(o.attestations, o.raw).toBe(0)
        }, 120_000)
      }
    })
  }
})
