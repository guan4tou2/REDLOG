import { describe, it, expect, beforeAll } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #288. The zsh adapter asked `redlog-relay.py classify` — a python3 start — for
// every command, to learn that `ls` is relayed. The answer is a function of the
// line and of two policy files, so it is now remembered per line and forgotten
// when either file is replaced.
//
// What this holds is that the cache is INVISIBLE: every answer it gives is the
// answer python would have given, including after the operator edits the
// overlay from this terminal or another one, and that a hit costs no process.
// A cache that is fast and occasionally one edit behind is the worse outcome —
// `redlog class nc native` that "did not take" would put a reverse shell
// through a relay.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

/** Lines whose text is hostile to being used as an associative-array key. */
const LINES = [
  'ls -la',
  'nmap -sV 10.0.0.5',
  'nc -lvnp 4444',
  'vim notes.txt',
  'cat /var/log/syslog | less',
  'echo hi > out.txt',
  'sudo -u root nc 10.0.0.1 80',
  'python3 -c "print(1)"',
  'python3',
  'echo [a] [[b]] ]',
  'echo "$(id)" `id` ${HOME}',
  "echo 'it'\\''s'",
  'echo *?[a-z]*',
  'echo (a|b) {c,d}',
  'echo a\\ b \\\\ c',
  'echo 日本語',
  'echo "unbalanced'
]

function script(hook: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return `
W=$(mktemp -d)
export HOME="$W"
mkdir -p "$W/.redlog"
unset _REDLOG_DIR _REDLOG_HOST WSL_DISTRO_NAME REDLOG_EXTERNAL_SESSION
source ${hook}

# Every start of python3, counted from a file: a function that counted in a
# variable would lose the count with the subshell that calls it.
python3() { print x >> "$W/calls"; command python3 "$@" }
calls() { if [[ -f "$W/calls" ]]; then wc -l < "$W/calls" | tr -d ' '; else print 0; fi }
reference() { _REDLOG_CLASS_CACHE=(); _REDLOG_CLASS_SIG=""; _redlog_class_of "$1"; print -r -- "$REPLY"; }

for line in ${LINES.map(q).join(' ')}; do
  ref=$(reference "$line")
  _REDLOG_CLASS_CACHE=(); _REDLOG_CLASS_SIG=""
  _redlog_class_of "$line"; first=$REPLY
  before=$(calls)
  _redlog_class_of "$line"; second=$REPLY
  after=$(calls)
  printf 'LINE\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$line" "$ref" "$first" "$second" "$(( after - before ))"
done

# --- the overlay changes under a warm cache ---
mv_overlay() { print -r -- "$1" > "$W/.redlog/tmp.json"; mv "$W/.redlog/tmp.json" "$W/.redlog/command-class.json" }
_redlog_class_of 'foo-tool --x'; print -- "STEP\\tbefore overlay\\t$REPLY"
mv_overlay '{"native":["foo-tool"]}'
_redlog_class_of 'foo-tool --x'; print -- "STEP\\toverlay says native\\t$REPLY"
mv_overlay '{"pty":["foo-tool"]}'
_redlog_class_of 'foo-tool --x'; print -- "STEP\\toverlay replaced, says pty\\t$REPLY"
rm -f "$W/.redlog/command-class.json"
_redlog_class_of 'foo-tool --x'; print -- "STEP\\toverlay deleted\\t$REPLY"
# The same, but the overlay is moved onto the command that was cached as native.
mv_overlay '{"native":["zzz"]}'
_redlog_class_of 'nc -l 1'; print -- "STEP\\tnc as shipped\\t$REPLY"
mv_overlay '{"relayed":["nc"],"removed":["nc"]}'
_redlog_class_of 'nc -l 1'; print -- "STEP\\tnc after removed from native\\t$REPLY"

# --- python3 failing is not remembered ---
rm -f "$W/.redlog/command-class.json"
_REDLOG_CLASS_CACHE=(); _REDLOG_CLASS_SIG=""
python3() { return 1 }
_redlog_class_of 'bar-tool'; print -- "STEP\\tpython3 failing\\t[$REPLY]"
python3() { print x >> "$W/calls"; command python3 "$@" }
_redlog_class_of 'bar-tool'; print -- "STEP\\tpython3 back\\t$REPLY"

# --- no zstat: no cache, every command asks ---
_redlog_policy_sig() { REPLY=""; return 1 }
before=$(calls)
_redlog_class_of 'baz-tool'; _redlog_class_of 'baz-tool'; _redlog_class_of 'baz-tool'
print -- "STEP\\twithout zstat, python starts for three commands\\t$(( $(calls) - before ))"

rm -rf "$W"
`
}

interface Row { line: string; ref: string; first: string; second: string; spawned: number }

describeShell('the zsh command-class cache', () => {
  let rows: Row[] = []
  const steps = new Map<string, string>()

  beforeAll(async () => {
    const hook = hookPath(target!, 'shell-zsh-hook.zsh')
    const run = await runInShell(target!, `
set -u
S=$(mktemp)
cat > "$S" <<'REDLOG_EOF'
${script(hook)}
REDLOG_EOF
zsh -f "$S"
rm -f "$S"
`, { timeoutMs: 180_000 })
    if (!run.stdout.includes('STEP')) throw new Error(`no output.\nstdout: ${run.stdout.slice(0, 500)}\nstderr: ${run.stderr.slice(0, 800)}`)
    for (const l of run.stdout.split('\n')) {
      const p = l.replace(/\r$/, '').split('\t')
      if (p[0] === 'LINE') rows.push({ line: p[1], ref: p[2], first: p[3], second: p[4], spawned: Number(p[5]) })
      if (p[0] === 'STEP') steps.set(p[1], p[2])
    }
  }, 240_000)

  it('has a row for every line tried', () => {
    expect(rows).toHaveLength(LINES.length)
    rows = rows.map((r) => r)
  })

  for (const line of LINES) {
    it(`${JSON.stringify(line)}: the cached answer is python's answer, and a hit starts no process`, () => {
      const r = rows.find((x) => x.line === line)!
      expect(r, 'row').toBeDefined()
      expect(['relayed', 'native', 'pty', 'redirected']).toContain(r.ref)
      expect(r.first).toBe(r.ref)
      expect(r.second).toBe(r.ref)
      expect(r.spawned, 'python3 starts on the second ask').toBe(0)
    })
  }

  it('asks python for the answers it needs to tell apart (the corpus is not all one class)', () => {
    expect(new Set(rows.map((r) => r.ref)).size).toBeGreaterThanOrEqual(3)
  })

  it('picks up an overlay written after the answer was cached, and one replaced, and one deleted', () => {
    expect(steps.get('before overlay')).toBe('relayed')
    expect(steps.get('overlay says native')).toBe('native')
    expect(steps.get('overlay replaced, says pty')).toBe('pty')
    expect(steps.get('overlay deleted')).toBe('relayed')
  })

  it('lets the operator take a command out of the shipped policy under a warm cache', () => {
    expect(steps.get('nc as shipped')).not.toBe('relayed')
    expect(steps.get('nc after removed from native')).toBe('relayed')
  })

  it('does not remember python3 failing', () => {
    expect(steps.get('python3 failing')).toBe('[]')
    expect(steps.get('python3 back')).toBe('relayed')
  })

  it('asks every time when there is no zstat to tell it the policy is unchanged', () => {
    expect(steps.get('without zstat, python starts for three commands')).toBe('3')
  })
})
