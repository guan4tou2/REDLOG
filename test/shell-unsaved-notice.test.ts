import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'

// FR-009, the half the "files missing" notice never covered. RedLog leaves
// api-port and api-token behind when it quits, and removes active-identity.json
// when its project closes. With the files there and no identity, a send that
// fails is dropped by design — "no identity" is "no project to record into" —
// and before this the operator was told nothing at all: not in zsh, and bash
// had no notice of any kind.
//
// Driven the way an operator's terminal runs it, without a PTY: an interactive
// shell (`zsh -i`, `bash -i`) reading its commands from stdin, in a throwaway
// HOME (and ZDOTDIR), with a `curl` on PATH whose exit status is read from a
// file at each call — 7 is a refused connection, 22 is `curl -f` on an HTTP
// error such as the 503 RedLog answers with no project open, 0 is delivered.
// A command can rewrite that file, so one session can fail, recover and fail
// again.
//
// REDLOG_TEST_HOOK_DIR points the shells at another copy of the hooks, which is
// how these were checked against the adapters before the notice existed.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'

interface Scenario {
  shell: Shell
  /** Exit status of the fake curl at the start. */
  curl: number
  identity: boolean
  /** Write api-port / api-token. */
  files?: boolean
  commands: string[]
}

interface Outcome { transcript: string; spooled: number; calls: number; raw: string }

const NOT_RECORDED = 'this terminal is not being recorded'

function script(s: Scenario): string {
  const ident = s.identity
    ? `printf '%s' '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"`
    : ''
  const files = s.files === false
    ? ''
    : `printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"`
  // The relay would try to open ptys for a relayed `echo`; this is about the
  // sender, so the commands used here are classed native in the overlay.
  const shellRun = s.shell === 'zsh'
    ? `zsh -d -i < "$work/cmds" > "$work/out" 2>&1`
    : `bash --rcfile "$work/bashrc" -i < "$work/cmds" > "$work/out" 2>&1`
  return `set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-unsaved.XXXXXX")
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" RCF="$work/rc"
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin"
${files}
${ident}
printf '%s' '{"native":["echo","printf","redlog"]}' > "$HOME/.redlog/command-class.json"
printf '%s' '${s.curl}' > "$RCF"
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
cat > /dev/null 2>&1
echo call >> "$RCF.calls"
exit "$(cat "$RCF")"
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' > "$work/bashrc"
cat > "$work/cmds" <<'CMDS'
${s.commands.join('\n')}
CMDS
${shellRun}
echo '@@OUT'; cat "$work/out"
echo "@@SPOOLED $(find "$HOME/.redlog/pending" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
echo "@@CALLS $(cat "$RCF.calls" 2>/dev/null | wc -l | tr -d ' ')"
`
}

async function run(s: Scenario): Promise<Outcome> {
  const r = await runInShell(target!, script(s), { timeoutMs: 60_000 })
  const out = r.stdout
  const at = out.indexOf('@@OUT\n')
  expect(at, `harness did not finish: ${r.stderr.slice(0, 400)}`).toBeGreaterThanOrEqual(0)
  const end = out.indexOf('@@SPOOLED ')
  return {
    transcript: out.slice(at + 6, end),
    spooled: Number(/@@SPOOLED (\d+)/.exec(out)?.[1] ?? NaN),
    calls: Number(/@@CALLS (\d+)/.exec(out)?.[1] ?? NaN),
    raw: out + r.stderr
  }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describeShell('a terminal says when its commands are being dropped', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    describe(shell, () => {
      it('RedLog not running, no project: one notice across two commands, nothing spooled', async () => {
        const o = await run({ shell, curl: 7, identity: false, commands: ['echo first-cmd', 'echo second-cmd'] })
        expect(o.transcript).toContain('first-cmd')
        expect(o.transcript).toContain('second-cmd')
        expect(o.calls, 'the sender never tried').toBeGreaterThan(0)
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(1)
        expect(o.transcript).toContain('[redlog] RedLog is not reachable; this terminal is not being recorded')
        expect(o.spooled).toBe(0)
      }, 90_000)

      it('RedLog answering with no project open: says that instead', async () => {
        const o = await run({ shell, curl: 22, identity: false, commands: ['echo first-cmd', 'echo second-cmd'] })
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(1)
        expect(o.transcript).toContain('[redlog] no project is open in RedLog; this terminal is not being recorded')
        expect(o.spooled).toBe(0)
      }, 90_000)

      it('identity present and the send fails: spooled, and no notice', async () => {
        const o = await run({ shell, curl: 7, identity: true, commands: ['echo first-cmd', 'echo second-cmd'] })
        expect(o.spooled, o.raw).toBeGreaterThan(0)
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(0)
      }, 90_000)

      it('a send that succeeds re-arms the notice, so a later loss is announced again', async () => {
        const o = await run({
          shell, curl: 22, identity: false,
          commands: [
            'echo lost-one',
            // command_start of this line is dropped, its command_end delivered.
            'printf 0 > "$RCF"; echo back-up',
            'echo delivered',
            // Delivered at its start, dropped at its end.
            'printf 22 > "$RCF"; echo down-again',
            'echo lost-two'
          ]
        })
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(2)
        const second = o.transcript.lastIndexOf(NOT_RECORDED)
        expect(second, 'the second notice came before the second loss').toBeGreaterThan(o.transcript.indexOf('down-again'))
        expect(second).toBeLessThan(o.transcript.indexOf('lost-two'))
        expect(o.spooled).toBe(0)
      }, 90_000)

      it('a terminal stopped with `redlog stop` is not told it is losing anything', async () => {
        const o = await run({ shell, curl: 7, identity: false, commands: ['redlog stop', 'echo while-stopped', 'echo still-stopped'] })
        expect(o.transcript).toContain('recording stopped in this terminal')
        expect(o.transcript).toContain('still-stopped')
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(0)
      }, 90_000)

      it('a paused RedLog answers 200, so nothing is said', async () => {
        const o = await run({ shell, curl: 0, identity: true, commands: ['echo paused-cmd', 'echo paused-again'] })
        expect(o.calls).toBeGreaterThan(0)
        expect(count(o.transcript, NOT_RECORDED), o.raw).toBe(0)
        expect(o.transcript).not.toContain('not reachable')
      }, 90_000)

      it('without the port and token files: the existing notice, once, and not a second line', async () => {
        const o = await run({ shell, curl: 7, identity: false, files: false, commands: ['echo first-cmd', 'echo second-cmd'] })
        expect(count(o.transcript, 'not reachable'), o.raw).toBe(1)
        expect(o.transcript).toContain('no project is open; commands and output are not being saved')
        expect(count(o.transcript, NOT_RECORDED)).toBe(0)
      }, 90_000)
    })
  }
})
