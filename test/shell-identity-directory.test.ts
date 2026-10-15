import { describe, it, expect } from 'vitest'
import { findShellTarget, runInShell, hookPath } from './helpers/zsh-pty'

const target = findShellTarget()
const suite = target ? describe : describe.skip

suite('shell identity follows the resolved RedLog directory', () => {
  for (const shell of ['bash', 'zsh']) for (const builder of ['auto', 'python']) {
    it(`${shell}/${builder} pins the receiving profile, not a stale Linux HOME identity`, async () => {
      const script = `
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
export HOME="$W/linux-home" _REDLOG_DIR="$W/windows-profile/.redlog"
mkdir -p "$HOME/.redlog" "$_REDLOG_DIR"
printf '%s' '{"engagementId":"stale-linux-project","operatorId":"linux-op"}' > "$HOME/.redlog/active-identity.json"
printf '%s' '{"engagementId":"current-windows-project","operatorId":"windows-op"}' > "$_REDLOG_DIR/active-identity.json"
cat > "$W/send" <<'SH'
. ${hookPath(target!, 'shell-common.sh')}
${shell === 'zsh' ? 'zmodload zsh/datetime' : ''}
REDLOG_PAYLOAD_BUILDER=${builder} _redlog_send_event command_end 'echo directory-canary' '{}'
SH
${shell} "$W/send"
python3 - "$W/windows-profile/.redlog/pending" <<'PY'
import glob,json,os,sys
files=glob.glob(os.path.join(sys.argv[1],'*.json'))
assert len(files)==1, files
print('IDENTITY '+json.dumps(json.load(open(files[0]))['_identity']))
PY
`
      const result = await runInShell(target!, script, { timeoutMs: 30_000 })
      const identity = result.stdout.split('\n').find(line => line.startsWith('IDENTITY '))
      expect(identity, result.stderr).toBeTruthy()
      expect(JSON.parse(identity!.slice(9))).toEqual({ engagementId: 'current-windows-project', operatorId: 'windows-op' })
    })
  }
})
