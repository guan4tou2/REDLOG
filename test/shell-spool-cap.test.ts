import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #255 follow-up. The shell hooks cap the spool at 5000 files so a machine
// whose RedLog has been closed for weeks cannot fill a disk. The count was of
// the whole directory — and replay now keeps what it cannot attribute as
// `*.json.unattributed`, so enough of those and every new event was dropped
// without a word. The cap is about what is waiting to be replayed.

const target: ShellTarget | null = findShellTarget()
const describeShell = target ? describe : describe.skip

describeShell('the spool cap in shell-common.sh', () => {
  it('is not used up by files replay already set aside', async () => {
    const script = `
set -u
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home/pending"
printf 1 > "$work/home/api-port"          # nothing listens here: the POST fails
printf t > "$work/home/api-token"
printf '{"engagementId":"eng-1","operatorId":"op-1"}' > "$work/home/active-identity.json"
seq 1 5000 | sed "s|^|$work/home/pending/|; s|\\$|.json.unattributed|" | xargs touch
export _REDLOG_DIR="$work/home" _REDLOG_HOST=127.0.0.1
source ${hookPath(target!, 'shell-common.sh')}
_redlog_send_event command_start 'id'
echo "WAITING=$(find "$work/home/pending" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')"
echo "SET_ASIDE=$(find "$work/home/pending" -maxdepth 1 -name '*.unattributed' | wc -l | tr -d ' ')"
`
    const run = await runInShell(target!, script, { timeoutMs: 120_000 })
    expect(run.stdout, run.stderr.slice(0, 400)).toContain('WAITING=1')
    expect(run.stdout).toContain('SET_ASIDE=5000')
  }, 150_000)
})
