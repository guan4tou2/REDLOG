import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'

// FR-010 (#689). A terminal is pinned to the project it opened in. Every event
// carries whatever `active-identity.json` says when it is sent, and RedLog
// accepts any event naming the project it has open, so a terminal left open
// across a project switch wrote into the new project unless it stopped itself.
// zsh did; bash did not, and its next command went out under the new
// engagement while its own state file still said `recording: true`.
//
// Driven as `shell-unsaved-notice.test.ts` drives them: an interactive shell
// reading commands from stdin, in a throwaway HOME, with a `curl` on PATH that
// appends each body it is given to a file and exits with the status read from
// another. REDLOG_TEST_HOOK_DIR points the shells at another copy of the hooks.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'

const IDENTITY_A = '{"engagementId":"eng-A","operatorId":"op-1"}'
const IDENTITY_B = '{"engagementId":"eng-B","operatorId":"op-1"}'
const SWITCH = `printf '%s' '${IDENTITY_B}' > "$HOME/.redlog/active-identity.json"`
const NOTICE = 'the project changed — this terminal stopped recording'

interface Sent { subtype: string; command: string; engagement: string | undefined; data: Record<string, unknown> }
interface Terminal { transcript: string; sent: Sent[]; state: Record<string, unknown> }
interface Outcome { terminals: Terminal[]; raw: string }

/** One HOME, one terminal per entry of `sessions`, run one after the other. */
function script(shell: Shell, sessions: string[][], rcAfter = ''): string {
  const run = (i: number): string => {
    const shellRun = shell === 'zsh'
      ? `zsh -d -i < "$work/cmds${i}" > "$work/out${i}" 2>&1`
      : `bash --rcfile "$work/bashrc" -i < "$work/cmds${i}" > "$work/out${i}" 2>&1`
    return `cat > "$work/cmds${i}" <<'CMDS'
${sessions[i].join('\n')}
CMDS
: > "$RCF.posts"
rm -rf "$HOME/.redlog/terminals"
${shellRun}
echo '@@OUT${i}'; cat "$work/out${i}"
echo '@@POSTS${i}'; cat "$RCF.posts"
echo '@@STATE${i}'; cat "$HOME"/.redlog/terminals/*.json 2>/dev/null; echo
echo '@@END${i}'`
  }
  return `set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-switch.XXXXXX")
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" RCF="$work/rc"
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin"
printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"
printf '%s' '${IDENTITY_A}' > "$HOME/.redlog/active-identity.json"
printf '%s' '{"native":["echo","printf","rm","redlog"]}' > "$HOME/.redlog/command-class.json"
printf 0 > "$RCF"
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
{ cat; echo; } >> "$RCF.posts" 2>/dev/null
exit "$(cat "$RCF")"
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' ${JSON.stringify(rcAfter)} > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' ${JSON.stringify(rcAfter)} > "$work/bashrc"
${sessions.map((_, i) => run(i)).join('\n')}
`
}

const between = (text: string, start: string, end: string): string => {
  const a = text.indexOf(start)
  const b = text.indexOf(end, a)
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0)
  return text.slice(a + start.length, b)
}

async function run(shell: Shell, sessions: string[][], rcAfter = ''): Promise<Outcome> {
  const r = await runInShell(target!, script(shell, sessions, rcAfter), { timeoutMs: 90_000 })
  const raw = r.stdout + r.stderr
  const terminals = sessions.map((_, i): Terminal => {
    const posts = between(r.stdout, `@@POSTS${i}\n`, `@@STATE${i}`)
    const sent = posts.split('\n').filter((l) => l.trim()).map((l): Sent => {
      const d = JSON.parse(l) as { data: Record<string, unknown>; _identity?: { engagementId?: string } }
      return { subtype: String(d.data.subtype), command: String(d.data.command ?? ''), engagement: d._identity?.engagementId, data: d.data }
    })
    const stateText = between(r.stdout, `@@STATE${i}\n`, `@@END${i}`).trim()
    return {
      transcript: between(r.stdout, `@@OUT${i}\n`, `@@POSTS${i}`),
      sent,
      state: stateText ? JSON.parse(stateText) as Record<string, unknown> : {}
    }
  })
  return { terminals, raw }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1
const named = (t: Terminal, needle: string): Sent[] => t.sent.filter((s) => s.command.includes(needle))

describeShell('a terminal stops when RedLog opens another project', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    describe(shell, () => {
      it('keeps recording while the project stays the same', async () => {
        const o = await run(shell, [['echo first-cmd', 'echo second-cmd']])
        const [t] = o.terminals
        for (const cmd of ['first-cmd', 'second-cmd']) {
          const rows = named(t, cmd)
          expect(rows.map((s) => s.subtype), o.raw).toEqual(['command_start', 'command_end'])
          expect(rows.every((s) => s.engagement === 'eng-A')).toBe(true)
        }
        expect(t.state.recording).toBe(true)
        expect(t.transcript).not.toContain(NOTICE)
      }, 120_000)

      it('sends nothing under the new identity after a switch, says so once, and is not also told it is losing commands', async () => {
        const o = await run(shell, [[
          'echo before-switch',
          SWITCH,
          // First after the switch, a subshell line: bash's DEBUG trap never
          // sees it, and the prompt records it from history instead, so that
          // path has to find the switch on its own.
          '( echo sub-after-switch )',
          'echo after-switch',
          // With no project and RedLog answering 503 a send is dropped, which
          // is what the unsaved notice is for. `redlog` lines are still sent
          // while stopped, so this one is dropped — and a stopped terminal
          // must not be told it is losing anything.
          'rm -f "$HOME/.redlog/active-identity.json"; printf 22 > "$RCF"',
          'redlog status',
          'echo still-after-switch'
        ]])
        const [t] = o.terminals
        expect(named(t, 'before-switch').map((s) => s.engagement), o.raw).toEqual(['eng-A', 'eng-A'])
        for (const cmd of ['after-switch', 'sub-after-switch', 'still-after-switch']) {
          expect(named(t, `echo ${cmd}`), `${cmd} was sent: ${o.raw}`).toEqual([])
        }
        expect(t.sent.filter((s) => s.subtype === 'command_start' && s.engagement === 'eng-B' && !s.command.startsWith('redlog')),
          'a command was sent under the new project').toEqual([])
        expect(t.state).toMatchObject({ recording: false, stoppedReason: 'project-switched', engagementId: 'eng-A' })
        const ended = t.sent.filter((s) => s.subtype === 'session_end')
        expect(ended, o.raw).toHaveLength(1)
        expect(ended[0].data).toMatchObject({ reason: 'project-switched', engagement_id: 'eng-A' })
        expect(count(t.transcript, NOTICE), o.raw).toBe(1)
        expect(t.transcript).toContain('still-after-switch')
        expect(t.transcript, o.raw).not.toContain('not being recorded')
        expect(t.transcript).not.toContain('not reachable')
      }, 120_000)

      it('cannot be started again in the old terminal; a new terminal records into the new project', async () => {
        const o = await run(shell, [
          [SWITCH, 'echo trigger', 'redlog start', 'echo after-start'],
          ['echo in-new-terminal']
        ])
        const [old, fresh] = o.terminals
        expect(old.transcript, o.raw).toContain('stopped (project-switched)')
        expect(named(old, 'echo after-start'), o.raw).toEqual([])
        expect(old.sent.some((s) => s.subtype === 'capture_resumed')).toBe(false)
        expect(old.state).toMatchObject({ recording: false, stoppedReason: 'project-switched' })
        const rows = named(fresh, 'in-new-terminal')
        expect(rows.map((s) => s.subtype), o.raw).toEqual(['command_start', 'command_end'])
        expect(rows.every((s) => s.engagement === 'eng-B')).toBe(true)
        expect(fresh.state).toMatchObject({ recording: true, engagementId: 'eng-B' })
      }, 120_000)

      it('records nothing of its own hook when stdin ends at the prompt', async () => {
        const o = await run(shell, [['echo only-cmd']])
        const [t] = o.terminals
        expect(t.sent.filter((s) => /_REDLOG_|_redlog_/.test(s.command)), o.raw).toEqual([])
        expect(t.sent.map((s) => s.command)).toEqual(['echo only-cmd', 'echo only-cmd'])
      }, 120_000)
    })
  }

  // Both hooks pin the identity they saw as they loaded, which is the one the
  // terminal's state was begun with; a switch before the first command is a
  // switch.
  for (const shell of ['zsh', 'bash'] as const) {
    it(`${shell}: a switch between loading and the first command is a switch`, async () => {
      const o = await run(shell, [['echo first-cmd']], SWITCH)
      const [t] = o.terminals
      expect(named(t, 'first-cmd'), o.raw).toEqual([])
      expect(t.state).toMatchObject({ recording: false, stoppedReason: 'project-switched', engagementId: 'eng-A' })
      expect(count(t.transcript, NOTICE)).toBe(1)
    }, 120_000)
  }
})
