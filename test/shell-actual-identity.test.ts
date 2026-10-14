import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  findShellTarget, runInShell, hookPath, startCollector, type ShellTarget, type ShellRun
} from './helpers/zsh-pty'

// #325. The `shell` field of a shell event said `$SHELL` — the shell the
// operator LOGGED IN with, inherited from the login environment — while the
// command that produced the event ran in whichever POSIX shell was actually
// executing it.
//
// It is wrong for the ordinary case, not an edge: an operator whose login
// shell is bash and who runs `zsh` gets a zsh session recorded as bash for
// the whole session, and the reverse for anyone who went the other way. Every
// downstream reading of the field — which shell produced a command, which
// adapter to blame for a gap in the record — is answered wrong, and the record
// is exactly the thing that is supposed to be evidence.
//
// So these tests do what no amount of reading the source can do: they run a
// real bash and a real zsh, each with the OTHER one exported as `$SHELL`, and
// read what was actually delivered. Nothing here asserts that the code looks
// right; every assertion is about the bytes the collector received.

const target: ShellTarget | null = findShellTarget()
// POSIX by construction: this file spawns real bash and real zsh.
const describeShell = process.platform === 'win32' ? describe.skip : target ? describe : describe.skip

const TOKEN = 'identity-token'

let collector: { port: number; events: Array<{ agentType: string; data: Record<string, unknown> }>; close: () => Promise<void> }

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An isolated HOME that believes RedLog is on `port`. */
function makeHome(port: number): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-identity-'))
  tempDirs.push(home)
  const redlog = path.join(home, '.redlog')
  fs.mkdirSync(redlog)
  fs.writeFileSync(path.join(redlog, 'api-port'), String(port))
  fs.writeFileSync(path.join(redlog, 'api-token'), TOKEN)
  return home
}

/** The events delivered since `from`, as `data` rows. */
function since(from: number): Array<Record<string, unknown>> {
  return collector.events.slice(from).map((e) => e.data)
}

/** The shell field of the event carrying `command`, or undefined. */
function shellOf(events: Array<Record<string, unknown>>, command: string): unknown {
  return events.find((d) => d.command === command)?.shell
}

/**
 * The same, waiting for delivery.
 *
 * `_redlog_send_event` POSTs in the foreground and the test can read the
 * collector the moment the shell exits. `redlog-send.sh` backgrounds its curl,
 * so that one is still in flight when its process is gone and a fixed sleep
 * would be a guess about how long the network takes.
 */
async function shellOfEventually(from: number, command: string): Promise<unknown> {
  for (let waited = 0; waited < 10_000; waited += 100) {
    const found = shellOf(since(from), command)
    if (found !== undefined) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

/**
 * Run `body` in a REAL bash or zsh.
 *
 * `runInShell` runs bash and only bash, so the shell under test is launched
 * from inside the script — the same shape `shell-payload-fast.test.ts` uses to
 * hold one script text to both shells. The script travels as a file for the
 * reason that helper gives: an argument does not survive Node's quoting and
 * WSL's re-parse intact.
 */
async function under(shell: 'bash' | 'zsh', home: string, env: Record<string, string>, body: string): Promise<ShellRun> {
  const script = `set -u
S=$(mktemp)
cat > "$S" <<'REDLOG_EOF'
${body}
REDLOG_EOF
${shell === 'zsh' ? 'zsh -f' : 'bash --norc'} "$S" 2>/dev/null
rm -f "$S"
`
  return runInShell(target!, script, {
    timeoutMs: 120_000,
    env: {
      HOME: home,
      SHELL: shell === 'bash' ? '/bin/zsh' : '/bin/bash',
      // Empty, not absent, and not whatever this machine happens to have. A
      // developer running RedLog's own hook has REDLOG_SHELL exported by their
      // interactive shell, and it would arrive in every one of these and answer
      // for the case that is about having nothing to inherit.
      REDLOG_SHELL: '',
      ...env
    }
  })
}

/**
 * The payload the shell wrote itself, and the one python3 wrote, for the same
 * event — the two builders #288 made interchangeable. Both go on the wire so
 * the comparison is of what RedLog would receive, not of a file's contents.
 */
const BOTH_BUILDERS = (hook: string): string => `
. "${hook}" >/dev/null
_redlog_send_event command_start 'identity-probe' '{"cwd":"/tmp"}'
REDLOG_PAYLOAD_BUILDER=python _redlog_send_event command_start 'identity-probe-python' '{"cwd":"/tmp"}'
`

describeShell('the shell an event records', () => {
  beforeAll(async () => {
    collector = await startCollector(TOKEN)
  }, 60_000)

  afterAll(async () => {
    await collector?.close()
  })

  it('records the shell running the command, not the login shell — bash running with SHELL=/bin/zsh', async () => {
    const home = makeHome(collector.port)
    const from = collector.events.length
    await under('bash', home, {}, BOTH_BUILDERS(hookPath(target!, 'shell-bash-hook.sh')))
    const events = since(from)

    expect(shellOf(events, 'identity-probe'), 'the shell-built payload').toBe('bash')
    expect(shellOf(events, 'identity-probe-python'), 'the python-built payload').toBe('bash')
  }, 120_000)

  it('records the shell running the command, not the login shell — zsh running with SHELL=/bin/bash', async () => {
    const home = makeHome(collector.port)
    const from = collector.events.length
    await under('zsh', home, {}, BOTH_BUILDERS(hookPath(target!, 'shell-zsh-hook.zsh')))
    const events = since(from)

    expect(shellOf(events, 'identity-probe'), 'the shell-built payload').toBe('zsh')
    expect(shellOf(events, 'identity-probe-python'), 'the python-built payload').toBe('zsh')
  }, 120_000)

  it('agrees with itself when the fast builder is the one that runs — bash under bash 3 has no EPOCHREALTIME', async () => {
    // `_redlog_build_payload_fast` declines without EPOCHREALTIME (bash < 5,
    // and zsh without zsh/datetime), so on macOS' bash 3.2 the fast path is
    // never the one taken and calling the builder directly is the only way to
    // hold it. The assignment is skipped when the shell has the real dynamic
    // variable, so bash 5 and zsh still measure their own time.
    const home = makeHome(collector.port)
    const probe = `
. "${hookPath(target!, 'shell-bash-hook.sh')}" >/dev/null
out=$(mktemp)
[[ -n "\${EPOCHREALTIME:-}" ]] || EPOCHREALTIME=1700000000.123456
_redlog_build_payload_fast command_start 'identity-fast' '{"cwd":"/tmp"}' "$out"
printf 'FAST_RC %s\\n' "$?"
printf 'FAST_PAYLOAD %s\\n' "$(cat "$out")"
rm -f "$out"
`
    const run = await under('bash', home, {}, probe)

    expect(run.stdout).toMatch(/FAST_RC 0/)
    const payload = /FAST_PAYLOAD (.*)/.exec(run.stdout)?.[1] ?? ''
    expect(payload, 'the fast builder wrote no payload').not.toBe('')
    expect(JSON.parse(payload).data.shell).toBe('bash')
  }, 120_000)

  it('agrees with itself when the fast builder is the one that runs — zsh, where EPOCHREALTIME is real', async () => {
    const home = makeHome(collector.port)
    const probe = `
. "${hookPath(target!, 'shell-zsh-hook.zsh')}" >/dev/null
out=$(mktemp)
_redlog_build_payload_fast command_start 'identity-fast' '{"cwd":"/tmp"}' "$out"
printf 'FAST_RC %s\\n' "$?"
printf 'FAST_PAYLOAD %s\\n' "$(cat "$out")"
rm -f "$out"
`
    const run = await under('zsh', home, {}, probe)

    expect(run.stdout).toMatch(/FAST_RC 0/)
    const payload = /FAST_PAYLOAD (.*)/.exec(run.stdout)?.[1] ?? ''
    expect(payload, 'the fast builder wrote no payload').not.toBe('')
    expect(JSON.parse(payload).data.shell).toBe('zsh')
  }, 120_000)

  it('still lets explicit extra data say otherwise', async () => {
    // `extra` is merged over the built fields, and it always was: the fast
    // builder splices it in after `shell`, the python builder `.update()`s
    // over `data`. An identity fix that read the field out of the payload
    // would be a regression, not a repair.
    const home = makeHome(collector.port)
    const from = collector.events.length
    const body = `
. "${hookPath(target!, 'shell-bash-hook.sh')}" >/dev/null
_redlog_send_event command_start 'identity-override' '{"cwd":"/tmp","shell":"override"}'
REDLOG_PAYLOAD_BUILDER=python _redlog_send_event command_start 'identity-override-python' '{"cwd":"/tmp","shell":"override"}'
`
    await under('bash', home, {}, body)
    const events = since(from)

    expect(shellOf(events, 'identity-override')).toBe('override')
    expect(shellOf(events, 'identity-override-python')).toBe('override')
  }, 120_000)

  it('names the shell it inherited when redlog-send.sh runs inside an adapter session', async () => {
    // redlog-send.sh is a standalone bash script a hook may call directly. Its
    // own runtime says nothing about who called it — it is bash however the
    // caller was — so the identity has to be inherited, and the adapter that
    // exports it is the only thing that knows it truthfully.
    //
    // Run as `bash <path>`, which is what it is: git records it 100644, so the
    // bare `hooks/redlog-send.sh …` in the docs cannot be what this relies on.
    // That is a documentation question of its own and not this issue's.
    const home = makeHome(collector.port)
    const from = collector.events.length
    const body = `
. "${hookPath(target!, 'shell-zsh-hook.zsh')}" >/dev/null
bash "${hookPath(target!, 'redlog-send.sh')}" 'identity-send-inherited' command_start '{"cwd":"/tmp"}'
`
    await under('zsh', home, {}, body)

    expect(await shellOfEventually(from, 'identity-send-inherited')).toBe('zsh')
  }, 120_000)

  it('reports unknown rather than inventing a caller when redlog-send.sh has nothing to inherit', async () => {
    // No adapter, so no inherited identity. `$SHELL` would say bash here, and
    // the script's own `#!/usr/bin/env bash` says bash, and the truth is that
    // neither knows what the caller was. `unknown` is the honest field; a
    // fabricated `bash` is a record of a shell nobody ran.
    const home = makeHome(collector.port)
    const from = collector.events.length
    const body = `bash "${hookPath(target!, 'redlog-send.sh')}" 'identity-send-bare' command_start '{"cwd":"/tmp"}'
`
    await under('zsh', home, {}, body)

    expect(await shellOfEventually(from, 'identity-send-bare')).toBe('unknown')
  }, 120_000)
})