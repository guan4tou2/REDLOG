import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #288 follow-up: `_redlog_divert` waits up to ~5 s for the relay to publish
// the pseudo-terminal names in `$dir/pts`, then read the file regardless. When
// the relay never wrote it, `$(<"$dir/pts" 2>/dev/null)` printed "no such file
// or directory" from the shell itself — a redirection error inside a command
// substitution is reported by the shell, not by the command the `2>` is on —
// and the operator saw a RedLog error in their terminal for a command that then
// ran perfectly well, un-recorded.
//
// The divert must fail quietly: return non-zero, print nothing, leave the
// shell's own stdout and stderr where they were.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

describeShell('_redlog_divert when the relay never answers', () => {
  it('fails without printing, and leaves the terminal streams alone', async () => {
    const script = `
set -u
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A relay that starts, says nothing and exits: pts never appears.
printf 'import sys\nsys.exit(0)\n' > "$work/relay.py"
cat > "$work/probe.zsh" <<'ZEOF'
source "$1"
_REDLOG_RELAY="$2"
_REDLOG_MAX_BYTES=1000
mkdir -p "$3"
_redlog_divert "$3"
print -r -- "rc=$?"
ZEOF
zsh -f "$work/probe.zsh" ${hookPath(target!, 'shell-zsh-hook.zsh')} "$work/relay.py" "$work/dir" >"$work/out" 2>"$work/err"
echo "OUT<$(cat "$work/out")>"
echo "ERR<$(cat "$work/err")>"
`
    const run = await runInShell(target!, script, { timeoutMs: 60_000 })
    expect(run.stdout).toMatch(/OUT<[^>]*rc=1>/)
    expect(run.stdout).toContain('ERR<>')
  }, 90_000)
})
