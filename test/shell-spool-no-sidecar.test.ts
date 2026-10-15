import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #315. RedLog leaves `api-port` and `api-token` behind when it quits, so a
// closed RedLog normally shows up to the hook as a POST that fails, and that
// path spools. The hook used to stop earlier than that whenever those two files
// were missing — deleted by a cleaner, never written, a profile restored
// without them — and then the command was dropped without a trace, where the
// PowerShell hook has always spooled. Nothing about a missing token stops a
// command from being kept: it is only needed to deliver one.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const prelude = `
set -u
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home"
export HOME="$work/home"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION
`

describeShell('a command typed when the hook has no api-port / api-token', () => {
  it('keeps every event when date has only second precision (BSD date)', async () => {
    const script = `${prelude}
source ${hookPath(target!, 'shell-common.sh')}
date() { printf '%s\\n' 1700000000N; }
_redlog_send_event command_start first
_redlog_send_event command_end first '{"exit_code":3}'
_redlog_send_event command_start second
python3 - "$HOME/.redlog/pending" <<'PY'
import glob, json, sys
rows = [json.load(open(f))['data'] for f in glob.glob(sys.argv[1] + '/*.json')]
print('ROWS', len(rows))
print('ENDS', sum(r['subtype'] == 'command_end' and r['exit_code'] == 3 for r in rows))
PY
`
    const run = await runInShell(target!, script, { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr).toContain('ROWS 3')
    expect(run.stdout).toContain('ENDS 1')
  }, 90_000)

  it('is spooled for replay, with no token to deliver it', async () => {
    const script = `${prelude}
source ${hookPath(target!, 'shell-common.sh')}
_redlog_send_event command_start 'nmap -sV 10.0.0.5'
echo "WAITING=$(find "$work/home/.redlog/pending" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
f=$(find "$work/home/.redlog/pending" -maxdepth 1 -name '*.json' 2>/dev/null | head -1)
[ -n "$f" ] && grep -o 'nmap -sV 10.0.0.5' "$f" | head -1
`
    const run = await runInShell(target!, script, { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('WAITING=1')
    expect(run.stdout).toContain('nmap -sV 10.0.0.5')
  }, 90_000)

  it('keeps the time the command ran, not the time it is replayed', async () => {
    const script = `${prelude}
source ${hookPath(target!, 'shell-common.sh')}
before=$(( $(date +%s) * 1000 ))
_redlog_send_event command_start 'id'
f=$(find "$work/home/.redlog/pending" -maxdepth 1 -name '*.json' | head -1)
ts=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['data']['source_timestamp'])" "$f")
[ "$ts" -ge "$before" ] && echo STAMP_OK
`
    const run = await runInShell(target!, script, { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('STAMP_OK')
  }, 90_000)

  it('still honours the spool cap, so a long absence cannot fill the disk', async () => {
    const script = `${prelude}
mkdir -p "$work/home/.redlog/pending"
seq 1 5000 | sed "s|^|$work/home/.redlog/pending/|; s|\\$|.json|" | xargs touch
source ${hookPath(target!, 'shell-common.sh')}
_redlog_send_event command_start 'id'
echo "WAITING=$(find "$work/home/.redlog/pending" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
`
    const run = await runInShell(target!, script, { timeoutMs: 120_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('WAITING=5000')
  }, 150_000)

  it('does nothing for a session RedLog itself launched elsewhere', async () => {
    const script = `${prelude}
export REDLOG_EXTERNAL_SESSION=1
source ${hookPath(target!, 'shell-common.sh')}
_redlog_send_event command_start 'id'
[ -e "$work/home/.redlog" ] && echo CREATED || echo UNTOUCHED
`
    const run = await runInShell(target!, script, { timeoutMs: 60_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('UNTOUCHED')
  }, 90_000)
})
