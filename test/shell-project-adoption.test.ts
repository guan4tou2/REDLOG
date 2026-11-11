import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findShellTarget, runInShell, type ShellTarget } from './helpers/zsh-pty'

// A terminal opened while no project was open is adopted by the first project
// RedLog opens after it (`_redlog_check_project` treats the first sight of the
// identity file as the pin). That used to happen in silence, right after the
// terminal had been told it was not being recorded. Now the prompt after the
// project opens says so once, naming the project.
//
// Driven as `shell-unsaved-notice.test.ts` and `shell-project-switch.test.ts`
// drive them: an interactive shell reading its commands from stdin, in a
// throwaway HOME (and ZDOTDIR), with a `curl` on PATH that appends each body it
// is given to a file and exits with the status read from another — 22 is
// `curl -f` on the 503 RedLog answers with no project open, 0 is delivered.
// REDLOG_TEST_HOOK_DIR points the shells at another copy of the hooks.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const hookDir = (): string =>
  process.env.REDLOG_TEST_HOOK_DIR ?? target!.toShellPath(path.join(__dirname, '..', 'hooks'))

type Shell = 'zsh' | 'bash'

const IDENTITY_A = '{"engagementId":"eng-A","operatorId":"op-1"}'
const IDENTITY_B = '{"engagementId":"eng-B","operatorId":"op-1"}'
const PROJECTS = '{"recent":[{"id":"eng-A","name":"Acme Internal"},{"id":"eng-B","name":"Beta Ext"}]}'
// RedLog opens a project: it writes the identity and starts answering.
const OPEN_A = `printf '%s' '${IDENTITY_A}' > "$HOME/.redlog/active-identity.json"; printf 0 > "$RCF"`
const OPEN_B = `printf '%s' '${IDENTITY_B}' > "$HOME/.redlog/active-identity.json"`

const ADOPTED = 'this terminal is now being recorded into it'
const ADOPTED_A = '[redlog] project "Acme Internal" is open in RedLog; this terminal is now being recorded into it'
const NOT_RECORDED = '[redlog] no project is open in RedLog; this terminal is not being recorded'
const SWITCHED = 'the project changed — this terminal stopped recording'

interface Scenario {
  shell: Shell
  /** Identity present before the hook loads. */
  identity: boolean
  commands: string[]
  builtin?: boolean
  /** Write RedLog's project index (the name's source). */
  projects?: boolean
}

interface Sent { subtype: string; command: string; engagement: string | undefined }
interface Outcome { transcript: string; sent: Sent[]; raw: string }

function script(s: Scenario): string {
  const shellRun = s.shell === 'zsh'
    ? `zsh -d -i < "$work/cmds" > "$work/out" 2>&1`
    : `bash --rcfile "$work/bashrc" -i < "$work/cmds" > "$work/out" 2>&1`
  return `set -u
work=$(mktemp -d "\${TMPDIR:-/tmp}/redlog-adopt.XXXXXX")
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" ZDOTDIR="$work/zdot" RCF="$work/rc"
mkdir -p "$HOME/.redlog" "$ZDOTDIR" "$work/bin"
printf 6660 > "$HOME/.redlog/api-port"; printf tok > "$HOME/.redlog/api-token"
${s.identity ? `printf '%s' '${IDENTITY_A}' > "$HOME/.redlog/active-identity.json"` : ''}
${s.projects === false ? '' : `printf '%s' '${PROJECTS}' > "$HOME/.redlog/projects.json"`}
printf '%s' '{"native":["echo","printf","redlog"]}' > "$HOME/.redlog/command-class.json"
printf '%s' '${s.identity ? 0 : 22}' > "$RCF"
cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
{ cat; echo; } >> "$RCF.posts" 2>/dev/null
exit "$(cat "$RCF")"
FAKE
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_TERMINAL REDLOG_TERMINAL_ID REDLOG_PAYLOAD_BUILDER
${s.builtin ? 'export REDLOG_TERMINAL=1 REDLOG_TERMINAL_ID=pane-1' : ''}
printf '%s\\n' 'unsetopt BG_NICE 2>/dev/null' 'PS1=' 'source "${hookDir()}/shell-zsh-hook.zsh"' > "$ZDOTDIR/.zshrc"
printf '%s\\n' 'PS1=' 'source "${hookDir()}/shell-bash-hook.sh"' > "$work/bashrc"
cat > "$work/cmds" <<'CMDS'
${s.commands.join('\n')}
CMDS
: > "$RCF.posts"
${shellRun}
echo '@@OUT'; cat "$work/out"
echo '@@POSTS'; cat "$RCF.posts"
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
  const raw = r.stdout + r.stderr
  const sent = between(r.stdout, '@@POSTS\n', '@@END').split('\n').filter((l) => l.trim()).map((l): Sent => {
    const d = JSON.parse(l) as { data: Record<string, unknown>; _identity?: { engagementId?: string } }
    return { subtype: String(d.data.subtype), command: String(d.data.command ?? ''), engagement: d._identity?.engagementId }
  })
  return { transcript: between(r.stdout, '@@OUT\n', '@@POSTS'), sent, raw }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1
const named = (o: Outcome, needle: string): Sent[] => o.sent.filter((s) => s.command.includes(needle))

describeShell('a terminal opened with no project says when a project adopts it', () => {
  for (const shell of ['zsh', 'bash'] as const) {
    describe(shell, () => {
      it('(a) loaded with a project open: no adoption line', async () => {
        const o = await run({ shell, identity: true, commands: ['echo first-cmd', 'echo second-cmd'] })
        expect(named(o, 'echo second-cmd').map((s) => s.engagement), o.raw).toEqual(['eng-A', 'eng-A'])
        expect(count(o.transcript, ADOPTED), o.raw).toBe(0)
      }, 120_000)

      it('(b) loaded with no project: dropped and told, then one line naming the project that adopted it', async () => {
        const o = await run({ shell, identity: false, commands: ['echo dropped-cmd', OPEN_A, 'echo after-open', 'echo later-cmd'] })
        const t = o.transcript
        expect(count(t, NOT_RECORDED), o.raw).toBe(1)
        expect(count(t, ADOPTED), o.raw).toBe(1)
        expect(t).toContain(ADOPTED_A)
        // Read as a pair, in this order, and before the next command runs.
        expect(t.indexOf(NOT_RECORDED)).toBeLessThan(t.indexOf(ADOPTED_A))
        expect(t.indexOf(ADOPTED_A)).toBeLessThan(t.indexOf('after-open\n'))
        expect(named(o, 'echo after-open').map((s) => [s.subtype, s.engagement]), o.raw)
          .toEqual([['command_start', 'eng-A'], ['command_end', 'eng-A']])
        expect(named(o, 'echo later-cmd').every((s) => s.engagement === 'eng-A')).toBe(true)
        expect(t).not.toContain(SWITCHED)
      }, 120_000)

      it('(b) without a name in the project index: names the project id', async () => {
        const o = await run({ shell, identity: false, projects: false, commands: ['echo dropped-cmd', OPEN_A, 'echo after-open'] })
        expect(count(o.transcript, ADOPTED), o.raw).toBe(1)
        expect(o.transcript).toContain('[redlog] project "eng-A" is open in RedLog; this terminal is now being recorded into it')
      }, 120_000)

      it('(c) a second project opening later is a switch, not a second adoption', async () => {
        const o = await run({ shell, identity: false, commands: ['echo dropped-cmd', OPEN_A, 'echo after-open', OPEN_B, 'echo after-switch', 'echo still-after'] })
        expect(count(o.transcript, ADOPTED), o.raw).toBe(1)
        expect(count(o.transcript, SWITCHED), o.raw).toBe(1)
        expect(o.transcript).not.toContain('"Beta Ext"')
        expect(named(o, 'echo after-switch'), o.raw).toEqual([])
        expect(named(o, 'echo still-after')).toEqual([])
      }, 120_000)

      it('(d) stopped with `redlog stop` before the project opens: no adoption line and nothing sent', async () => {
        const o = await run({ shell, identity: false, commands: ['redlog stop', OPEN_A, 'echo while-stopped', 'echo still-stopped'] })
        expect(o.transcript, o.raw).toContain('recording stopped in this terminal')
        expect(o.transcript).toContain('still-stopped')
        expect(count(o.transcript, ADOPTED), o.raw).toBe(0)
        expect(o.sent.filter((s) => s.engagement === 'eng-A'), o.raw).toEqual([])
      }, 120_000)

      it('(e) a built-in pane says nothing when its project opens', async () => {
        const o = await run({ shell, identity: false, builtin: true, commands: ['echo at-picker', OPEN_A, 'echo after-open'] })
        expect(o.transcript, o.raw).toContain('after-open')
        expect(count(o.transcript, ADOPTED), o.raw).toBe(0)
        expect(o.transcript).not.toContain('not being recorded')
      }, 120_000)
    })
  }
})
