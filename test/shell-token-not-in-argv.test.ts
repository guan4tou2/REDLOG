import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'
import path from 'node:path'

// #489. A process listing shows every process's argument vector to every user
// on a shared host, so the bearer token must reach curl some other way. Each
// sender below runs for real against a `curl` (and, for the VPS deploy, an
// `ssh`) on PATH that records exactly what it was handed:
//
//   argv    what a process listing would show
//   config  what curl was told to read with `-K`, i.e. what actually carried
//           the credential
//   body    what curl read from stdin
//
// The positive checks matter as much as the negative one. "The token is not in
// argv" is also true of a sender that stopped authenticating, so each case
// also requires the token to arrive in the config and the event in the body.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const MARK = 'REDLOG-SENTINEL-COMMAND-TEXT'

// What each fake records. `done` is appended last, so a test that backgrounds a
// sender can wait until every started call has finished writing.
const FAKE_CURL = String.raw`#!/bin/sh
rec=$REC
{ printf 'CALL'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$rec/argv"
cfg=''; body=0; prev=''
for a in "$@"; do
  [ "$prev" = "-K" ] && cfg=$a
  [ "$a" = "@-" ] && body=1
  prev=$a
done
case "$cfg" in
  '') ;;
  -) cat >> "$rec/config" ;;
  *) cat "$cfg" >> "$rec/config" ;;
esac
if [ "$body" = 1 ]; then cat >> "$rec/body"; printf '\n' >> "$rec/body"; fi
echo done >> "$rec/done"
exit 0
`

const FAKE_SSH = String.raw`#!/bin/sh
rec=$REC
{ printf 'CALL'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$rec/argv"
if [ ! -t 0 ]; then cat >> "$rec/body"; fi
echo done >> "$rec/done"
exit 0
`

function harness(body: string): string {
  return `set -u
TOKEN='${TOKEN}'
MARK='${MARK}'
export MARK
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME/.redlog" "$work/bin" "$work/rec"
printf 6660 > "$HOME/.redlog/api-port"
printf '%s' "$TOKEN" > "$HOME/.redlog/api-token"
printf '{"engagementId":"eng-1","operatorId":"op-1"}' > "$HOME/.redlog/active-identity.json"
cat > "$work/bin/curl" <<'FAKE_CURL'
${FAKE_CURL}FAKE_CURL
cat > "$work/bin/ssh" <<'FAKE_SSH'
${FAKE_SSH}FAKE_SSH
cp "$work/bin/ssh" "$work/bin/scp"
chmod +x "$work/bin/curl" "$work/bin/ssh" "$work/bin/scp"
export PATH="$work/bin:$PATH" REC="$work/rec"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION REDLOG_PAYLOAD_BUILDER
touch "$REC/argv" "$REC/config" "$REC/body" "$REC/done"
${body}
# Backgrounded senders (redlog-send.sh) may still be running.
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
  [ "$(wc -l < "$REC/done")" -ge "$(wc -l < "$REC/argv")" ] && break
  sleep 0.2
done
echo '@@ARGV'; cat "$REC/argv"
echo '@@CONFIG'; cat "$REC/config"
echo '@@BODY'; cat "$REC/body"
`
}

interface Recorded { argv: string; config: string; body: string; stdout: string; stderr: string }

async function run(script: string): Promise<Recorded> {
  const r = await runInShell(target!, harness(script), { timeoutMs: 60_000 })
  const out = r.stdout
  const a = out.indexOf('@@ARGV\n')
  const c = out.indexOf('@@CONFIG\n')
  const b = out.indexOf('@@BODY\n')
  expect(a, `harness did not finish: ${r.stderr.slice(0, 400)}`).toBeGreaterThanOrEqual(0)
  return {
    argv: out.slice(a + 7, c),
    config: out.slice(c + 9, b),
    body: out.slice(b + 7),
    stdout: out.slice(0, a),
    stderr: r.stderr
  }
}

function eventCalls(rec: Recorded): string[] {
  return rec.argv.split('\n').filter((line) => line.includes('/api/'))
}

function expectTokenOutOfArgv(rec: Recorded): void {
  // First, and alone: this is the line that names the leak.
  expect(rec.argv, 'the bearer token is in an argument vector').not.toContain(TOKEN)
  expect(rec.argv.length, 'nothing was recorded, so nothing was checked').toBeGreaterThan(0)
}

function expectDelivered(rec: Recorded): void {
  expect(rec.config).toContain(`Authorization: Bearer ${TOKEN}`)
  expect(rec.body).toContain(MARK)
}

const common = (file: string): string => hookPath(target!, file)
const repoFile = (...parts: string[]): string => target!.toShellPath(path.join(__dirname, '..', ...parts))

describeShell('the bearer token is not in the argv of any shell sender (#489)', () => {
  it('shell-common _redlog_post, bash, from the fast builder and from the python builder', async () => {
    const rec = await run(`
export _REDLOG_HOST=127.0.0.1
bash -c 'source "$1"; _redlog_send_event command_start "echo $MARK"; REDLOG_PAYLOAD_BUILDER=python _redlog_send_event command_end "echo $MARK" "{\\"exit_code\\":0}"' bash ${common('shell-common.sh')}
`)
    expectTokenOutOfArgv(rec)
    expect(eventCalls(rec).length).toBe(2)
    expectDelivered(rec)
    expect(rec.body.split('\n').filter((l) => l.includes('command_end')).length).toBe(1)
    // The body stays on stdin, never a path (#345).
    expect(rec.argv).toContain('[@-]')
    expect(rec.argv).not.toMatch(/\[@\//)
  }, 90_000)

  it('shell-common _redlog_post, zsh', async () => {
    const rec = await run(`
export _REDLOG_HOST=127.0.0.1
zsh -f -c 'source "$1"; _redlog_send_event command_start "echo $MARK"' zsh ${common('shell-common.sh')}
`)
    expectTokenOutOfArgv(rec)
    expect(eventCalls(rec).length).toBe(1)
    expectDelivered(rec)
    expect(rec.argv).toContain('[@-]')
  }, 90_000)

  it('hooks/redlog-send.sh, with the command text out of argv as well', async () => {
    const rec = await run(`
export _REDLOG_HOST=127.0.0.1
bash ${repoFile('hooks', 'redlog-send.sh')} "echo $MARK" command_start
`)
    expectTokenOutOfArgv(rec)
    // The payload carries the command text; it is as private as the token.
    expect(rec.argv, 'the command text is in an argument vector').not.toContain(MARK)
    expect(eventCalls(rec).length).toBe(1)
    expectDelivered(rec)
  }, 90_000)

  it('shell/redlog-agent.sh, for every call it makes', async () => {
    const rec = await run(`
bash -c 'source "$1"
redlog_mark "title $MARK" "note"
redlog_event agent "{\\"subtype\\":\\"x\\",\\"note\\":\\"$MARK\\"}"
redlog_search foo
redlog_status >/dev/null' bash ${repoFile('shell', 'redlog-agent.sh')}
`)
    expectTokenOutOfArgv(rec)
    expect(rec.argv, 'the event text is in an argument vector').not.toContain(MARK)
    expect(eventCalls(rec).length).toBe(4)
    // Reads authenticate too: four calls, four configs.
    expect(rec.config.split(`Authorization: Bearer ${TOKEN}`).length - 1).toBe(4)
    expect(rec.body).toContain(MARK)
  }, 90_000)

  it('hooks/vps-deploy.sh install: the token goes to the VPS on stdin, not in ssh/scp argv', async () => {
    const rec = await run(`
export REDLOG_REMOTE_TOKEN="$TOKEN"
bash ${repoFile('hooks', 'vps-deploy.sh')} install op@vps.example >/dev/null
`)
    expectTokenOutOfArgv(rec)
    // And it was sent: this is the stdin of the `cat > ~/.redlog/api-token`.
    expect(rec.body).toContain(TOKEN)
  }, 90_000)
})
