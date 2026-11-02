import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #296. A relayed command gets a `redlog-relay.*` directory in $TMPDIR, and the
// shell removes it at the next prompt. A shell killed while the command ran
// never reaches that prompt, so the directory stayed — 3,776 of them (55 MB) on
// one box. Loading the hook now sweeps the ones whose owner is gone.
//
// Each case is a directory the hook has to decide about, and the two that must
// SURVIVE are the ones that matter: a sweep that removes a live shell's
// directory breaks that shell's command_end.

const zshTarget: ShellTarget | null = findShellTarget()
const bashTarget: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }

const kinds = [
  { name: 'zsh', target: zshTarget, hook: 'shell-zsh-hook.zsh', skip: !zshTarget },
  { name: 'bash', target: bashTarget, hook: 'shell-bash-hook.sh', skip: process.platform === 'win32' }
] as const

for (const kind of kinds) {
  const describeShell = kind.skip ? describe.skip : describe

  describeShell(`relay directories left by a killed ${kind.name} (${kind.target?.label ?? 'no shell reachable'})`, () => {
    let listing = ''
    let during = ''
    let ownPid = ''
    let ok = false
    let error = ''
    let collector: Awaited<ReturnType<typeof startCollector>>
    const token = `relay-sweep-${kind.name}`

    afterAll(async () => { await collector?.close() })

    beforeAll(async () => {
      const target = kind.target!
      // RedLog has to look reachable, or no command is relayed at all.
      collector = await startCollector(token)
      // Fixtures are made in the shell, before the hook loads, in a TMPDIR of
      // its own: the real /tmp is shared with every other shell on the box.
      const rc = [
        'export TMPDIR=$(mktemp -d)',
        'age() { python3 -c "import os,sys,time; t=time.time()-600; os.utime(sys.argv[1],(t,t))" "$1"; }',
        // An owner that is gone: a pid that has been reaped.
        'sh -c "exit 0" & dead=$!; wait $dead',
        'mkdir -m 700 "$TMPDIR/redlog-relay.$dead.stale"',
        // An owner that is alive.
        '( sleep 25 & echo $! > "$TMPDIR/live.pid" )',
        'sleep 0.3',
        'live=$(cat "$TMPDIR/live.pid")',
        'mkdir -m 700 "$TMPDIR/redlog-relay.$live.alive"',
        // The older zsh name, which carries no owner: old and unreferenced,
        // old but named on a running process's command line, and fresh.
        'mkdir -m 700 "$TMPDIR/redlog-relay.Old001" && age "$TMPDIR/redlog-relay.Old001"',
        'mkdir -m 700 "$TMPDIR/redlog-relay.Live02" && age "$TMPDIR/redlog-relay.Live02"',
        '( sh -c "sleep 25; :" _ "$TMPDIR/redlog-relay.Live02" & echo $! > "$TMPDIR/ref.pid" )',
        'mkdir -m 700 "$TMPDIR/redlog-relay.New003"',
        'mkdir -m 700 "$TMPDIR/unrelated-dir"',
        `source ${hookPath(target, kind.hook)}`
      ].join('\n')
      const report = await runZsh(target, {
        shellKind: kind.name,
        rc,
        commands: [
          // The sweep runs behind the prompt; wait for it rather than guess.
          'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -e "$TMPDIR/redlog-relay.$dead.stale" ] || break; sleep 0.5; done; ls -1 "$TMPDIR" | sed "s/^/ENTRY /"',
          // A relayed command: its directory exists while it runs.
          'echo "me=$$"; ls -d "$TMPDIR"/redlog-relay.* | sed "s/^/DURING /"',
          'kill $live $(cat "$TMPDIR/ref.pid") 2>/dev/null; rm -rf "$TMPDIR"'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 40
      })
      ok =report.ok
      error = report.error ?? ''
      listing = report.steps[0]?.output ?? ''
      during = report.steps[1]?.output ?? ''
      ownPid = /me=(\d+)/.exec(during)?.[1] ?? ''
    }, 300_000)

    it('removes the directory of a shell that is gone', () => {
      expect(ok, error).toBe(true)
      expect(listing).toContain('ENTRY unrelated-dir')
      expect(listing).not.toMatch(/ENTRY redlog-relay\.\d+\.stale/)
    })

    it('removes an old directory that no process names', () => {
      expect(listing).toContain('ENTRY unrelated-dir')
      expect(listing).not.toContain('ENTRY redlog-relay.Old001')
    })

    it('keeps the directory of a shell that is alive', () => {
      expect(listing).toMatch(/ENTRY redlog-relay\.\d+\.alive/)
    })

    it('keeps a directory a running process still names, and a fresh one', () => {
      expect(listing).toContain('ENTRY redlog-relay.Live02')
      expect(listing).toContain('ENTRY redlog-relay.New003')
    })

    it('names its own relay directory after the shell, so the next sweep can tell it is live', () => {
      expect(ownPid, during).toMatch(/^\d+$/)
      expect(during).toMatch(new RegExp(`redlog-relay\\.${ownPid}\\.`))
    })
  })
}
