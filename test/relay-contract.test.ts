import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// Spec 052 T008. The output relay already exists, inside `redlog-run` in
// `hooks/shell-common.sh`: a pair of named pipes, two `tee`s, and a Python
// event builder that reads the temp files directly. T009 moves it into
// `hooks/redlog-relay.py` so the automatic path and the explicit wrapper share
// one implementation (research.md D2, Principle III).
//
// This file is the contract that extraction has to satisfy, written before the
// move so it fails for the right reason — no relay yet — rather than passing
// against whatever the extraction happens to produce. It pins the four things
// the current relay gets right and that are easy to lose when code changes
// hands:
//
//   1. bytes reach the terminal WHILE the command runs, not at exit;
//   2. the command's own exit status is what the caller sees;
//   3. byte counts are the real ones, counted before the cap, and truncation
//      is declared rather than silent;
//   4. arbitrary bytes survive — the relay reads files, never argv, and
//      invalid UTF-8 becomes U+FFFD instead of an exception.
//
// `test/shell-redlog-run.test.ts` keeps covering `redlog-run` end to end and
// must not need changing (T010); if it does, the extraction changed behaviour.
// That file is POSIX-only and therefore skipped on the machine this is written
// on, which is half the reason this one goes through the WSL target instead.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

const EVENT_OPEN = '<<<REDLOG-EVENT>>>'
const EVENT_CLOSE = '<<<REDLOG-END>>>'

interface RelayResult {
  /** What the caller of the relay saw on its own descriptors. */
  terminalStdout: string
  terminalStderr: string
  /** The exit status the relay propagated. */
  status: number
  /** True when the relay recorded that it got as far as starting the command;
   *  this is what tells a caller "the command ran, do not run it again". */
  started: boolean
  event: Record<string, unknown> | null
  streamedEarlyBy: number
}

/** Drive `hooks/redlog-relay.py` the way `redlog-run` will: an event file it
 *  writes, a command it runs, the command's status back. The event goes to a
 *  file and not to stdout for the obvious reason — stdout belongs to the
 *  command. */
async function relay(
  t: ShellTarget,
  command: string,
  opts: { maxBytes?: number } = {}
): Promise<RelayResult> {
  const script = `
D=\$(mktemp -d -t redlog-relay-test.XXXXXX)
python3 "${hookPath(t, 'redlog-relay.py')}" run \\
  --event-out "\$D/event.json" \\
  --max-bytes ${opts.maxBytes ?? 102400} \\
  --cwd "\$D" \\
  --captured-by redlog-run \\
  --command-id cid-for-the-test \\
  -- ${command}
code=\$?
printf '\\n${EVENT_OPEN}%s\\n' "\$code"
[ -e "\$D/event.json.started" ] && printf 'STARTED\\n'
cat "\$D/event.json" 2>/dev/null
printf '\\n${EVENT_CLOSE}\\n'
rm -rf "\$D"
`
  const run = await runInShell(t, script)
  const body = run.stdout.split(EVENT_OPEN)[1] ?? ''
  const [head] = body.split(EVENT_CLOSE)
  const lines = (head ?? '').split('\n')
  const status = Number(lines.shift())
  const started = lines[0] === 'STARTED'
  if (started) lines.shift()
  const json = lines.join('\n').trim()
  return {
    terminalStdout: run.stdout.split(EVENT_OPEN)[0] ?? '',
    terminalStderr: run.stderr,
    status,
    started,
    event: json ? (JSON.parse(json) as Record<string, unknown>) : null,
    streamedEarlyBy: run.firstStdoutAt === null ? 0 : run.endedAt - run.firstStdoutAt
  }
}

describeShell(`relay contract (${target?.label ?? 'no shell reachable'})`, () => {
  it('streams to the terminal while the command runs, then reports what it saw', async () => {
    const r = await relay(target!, `sh -c 'printf FIRST; sleep 1; printf SECOND; printf ERR >&2; exit 7'`)

    // (2) the caller gets the command's status, never the relay's.
    expect(r.status).toBe(7)
    expect(r.started).toBe(true)
    // (1) the bytes, in order, on the right descriptors…
    expect(r.terminalStdout).toContain('FIRSTSECOND')
    expect(r.terminalStderr).toContain('ERR')
    // …and the first of them well before the command exited. Flushing at exit
    // would satisfy every other assertion here and be useless to an operator
    // watching a scan run.
    expect(r.streamedEarlyBy).toBeGreaterThan(400)

    expect(r.event).toMatchObject({
      exit_code: 7,
      stdout: 'FIRSTSECOND',
      stderr: 'ERR',
      stdout_bytes: 11,
      stderr_bytes: 3,
      stdout_truncated: false,
      stderr_truncated: false,
      captured_by: 'redlog-run'
    })
    expect(r.event!.duration_sec as number).toBeGreaterThanOrEqual(1)
    expect(String(r.event!.cwd)).not.toBe('')
    // The caller's correlation key, carried through untouched. The relay
    // never mints one: `command_start` has already gone out with the caller's,
    // and an id invented here would correlate with nothing.
    expect(r.event!.command_id).toBe('cid-for-the-test')
    expect(r.event).toMatchObject({
      completeness: 'complete',
      output_disposition: 'captured',
      limit_hit: null
    })
  }, 60_000)

  it('counts every byte and declares the cut when it caps', async () => {
    const r = await relay(target!, `sh -c "printf 'x%.0s' \\$(seq 1 200)"`, { maxBytes: 64 })

    expect(r.status).toBe(0)
    // (3) The cap applies to what is carried, not to what is counted. An
    // operator reading "stdout_bytes: 64" of a 200-byte scan would believe the
    // record is complete; the whole point of the field is to say it is not.
    expect(String(r.event!.stdout)).toHaveLength(64)
    expect(r.event!.stdout_bytes).toBe(200)
    expect(r.event!.stdout_truncated).toBe(true)
    expect(r.event!.stderr_truncated).toBe(false)
    // And it names the bound it hit, so the gap in the evidence has a size
    // and a reason rather than being a shorter answer than the truth.
    expect(r.event).toMatchObject({ completeness: 'truncated', limit_hit: 'stdout:64' })
    // The terminal is not capped — the cap is the record's, not the operator's.
    expect(r.terminalStdout).toContain('x'.repeat(200))
  }, 60_000)

  it('survives bytes that are not text', async () => {
    const r = await relay(target!, `sh -c 'printf "A\\\\377\\\\376B"'`)

    expect(r.status).toBe(0)
    // (4) Four bytes in, four counted; the two that are not UTF-8 are replaced
    // rather than thrown. A JSON encoder that raises here loses the event, and
    // the command the operator most wants recorded is the one that returned
    // something strange.
    expect(r.event!.stdout_bytes).toBe(4)
    expect(String(r.event!.stdout)).toBe('A��B')
    expect(r.event!.stdout_truncated).toBe(false)
  }, 60_000)

  it('reports a command that does not exist as the shell would, and says it tried', async () => {
    const r = await relay(target!, 'redlog-no-such-command-052')

    expect(r.status).toBe(127)
    // `started` is the caller's instruction not to re-run: the relay owned the
    // attempt, so `redlog-run` must not fall through to `command "$@"` and
    // produce a second "not found" on the operator's terminal.
    expect(r.started).toBe(true)
    // Nothing was ever held, which is not the same as having produced
    // nothing, and the event says which it was.
    expect(r.event).toMatchObject({
      exit_code: 127,
      completeness: 'metadata-only',
      output_disposition: 'not-captured'
    })
    expect(r.terminalStderr).toContain('redlog-no-such-command-052')
  }, 60_000)
})

// T010. `redlog-run` now calls the relay instead of carrying its own copy.
// `test/shell-redlog-run.test.ts` is the end-to-end cover for that wrapper and
// must not need changing — but it spawns bash with a `#!/bin/sh` curl shim, so
// it is skipped on win32 and CI's ubuntu leg is the first place it runs. On a
// branch that rewrites the wrapper's whole body, finding that out from CI is
// the six-minute round trip CLAUDE.md is about. This runs the same scenario
// through the WSL target, so the extraction is proven before it is pushed.
describeShell(`redlog-run end to end (${target?.label ?? 'no shell reachable'})`, () => {
  async function wrapper(t: ShellTarget, line: string) {
    const script = `
H=\$(mktemp -d -t redlog-run-e2e.XXXXXX)
mkdir -p "\$H/.redlog" "\$H/bin"
printf '6660' > "\$H/.redlog/api-port"
printf 'test-token' > "\$H/.redlog/api-token"
cat > "\$H/bin/curl" <<'SHIM'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    printf '%s\\n' "$1" >> "$REDLOG_TEST_PAYLOADS"
  fi
  shift
done
exit 0
SHIM
chmod +x "\$H/bin/curl"
export HOME="\$H"
export PATH="\$H/bin:\$PATH"
export REDLOG_TEST_PAYLOADS="\$H/payloads.jsonl"
source "${hookPath(t, 'shell-bash-hook.sh')}" >/dev/null
${line}
code=\$?
printf '\\n${EVENT_OPEN}%s\\n' "\$code"
cat "\$REDLOG_TEST_PAYLOADS" 2>/dev/null
printf '${EVENT_CLOSE}\\n'
rm -rf "\$H"
`
    const run = await runInShell(t, script)
    const body = (run.stdout.split(EVENT_OPEN)[1] ?? '').split(EVENT_CLOSE)[0] ?? ''
    const lines = body.split('\n').filter((l) => l.trim() !== '')
    return {
      terminalStdout: run.stdout.split(EVENT_OPEN)[0] ?? '',
      terminalStderr: run.stderr,
      status: Number(lines.shift()),
      payloads: lines.map((l) => JSON.parse(l) as { data: Record<string, unknown> }),
      streamedEarlyBy: run.firstStdoutAt === null ? 0 : run.endedAt - run.firstStdoutAt
    }
  }

  it('sends the same command_end it always did', async () => {
    const r = await wrapper(target!,
      `redlog-run sh -c 'printf REDLOG_FIRST; sleep 1; printf REDLOG_SECOND; printf REDLOG_ERR >&2; exit 7'`)

    expect(r.status).toBe(7)
    expect(r.terminalStdout).toContain('REDLOG_FIRSTREDLOG_SECOND')
    expect(r.terminalStderr).toContain('REDLOG_ERR')
    expect(r.streamedEarlyBy).toBeGreaterThan(400)

    const start = r.payloads.find((p) => p.data.subtype === 'command_start')
    const end = r.payloads.find((p) => p.data.subtype === 'command_end'
      && p.data.captured_by === 'redlog-run')
    // One key, minted by the shell, on both ends of the command. Everything
    // the chunk stream will hang off hangs off this (contracts/events.md).
    expect(start?.data.command_id).toBeTruthy()
    expect(end?.data.command_id).toBe(start?.data.command_id)
    // Field for field what test/shell-redlog-run.test.ts asserts. If this
    // drifts, the extraction changed behaviour and that file is wrong too.
    expect(end?.data).toMatchObject({
      exit_code: 7,
      stdout: 'REDLOG_FIRSTREDLOG_SECOND',
      stderr: 'REDLOG_ERR',
      stdout_bytes: 25,
      stderr_bytes: 10,
      stdout_truncated: false,
      stderr_truncated: false,
      captured_by: 'redlog-run'
    })
  }, 60_000)

  it('runs a builtin in this shell and says the output was never held', async () => {
    // The relay launches a process; a builtin in a process is a no-op, so
    // `cd` has to run where it always ran. What must not happen is a record
    // that reports empty output as if it had been captured.
    const r = await wrapper(target!, `redlog-run cd /tmp\npwd`)

    expect(r.status).toBe(0)
    expect(r.terminalStdout).toContain('/tmp')
    const end = r.payloads.find((p) => p.data.subtype === 'command_end'
      && p.data.captured_by === 'redlog-run')
    expect(end?.data).toMatchObject({
      exit_code: 0,
      completeness: 'metadata-only',
      output_disposition: 'not-captured'
    })
    expect(end?.data.stdout).toBeUndefined()
  }, 60_000)
})
