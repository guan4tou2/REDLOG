import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { findShellTarget, runInShell, runZsh, startCollector, hookPath, type ShellTarget } from './helpers/zsh-pty'

// #296 (round 2, problem 5). `exit` in a hooked shell left one
// `redlog-relay.*` directory behind, in bash and in zsh. The directory is made
// when a relayed command starts and removed at the next prompt; `exit` is a
// relayed command like any other, and no prompt follows it. The load-time
// sweep (relay-dir-sweep.pty.test.ts) clears these up eventually; this is the
// shell that makes one every time it is closed on purpose.
//
// The driver ends every run by typing `exit` at the prompt, so a case does
// not need to send one: it needs a TMPDIR it can look into afterwards.

const zshTarget: ShellTarget | null = findShellTarget()
const bashTarget: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }

// `own` is an EXIT trap the operator already had when the hook loaded. Bash
// keeps one, so the hook has to add to it and not replace it; the marker file
// is how the test sees theirs ran.
const kinds = [
  { name: 'zsh', target: zshTarget, hook: 'shell-zsh-hook.zsh', skip: !zshTarget, own: false },
  { name: 'bash', target: bashTarget, hook: 'shell-bash-hook.sh', skip: process.platform === 'win32', own: false },
  { name: 'bash', target: bashTarget, hook: 'shell-bash-hook.sh', skip: process.platform === 'win32', own: true }
] as const

for (const kind of kinds) {
  const describeShell = kind.skip ? describe.skip : describe

  const title = `relay directory left by exit in ${kind.name}${kind.own ? ' with its own EXIT trap' : ''}`
  describeShell(`${title} (${kind.target?.label ?? 'no shell reachable'})`, () => {
    let collector: Awaited<ReturnType<typeof startCollector>>
    let ok = false
    let error = ''
    let during = ''
    let after = ''
    const token = `relay-exit-${kind.name}${kind.own ? '-own' : ''}`
    // Made on the shell's own side and named here, so it can be read after
    // the shell is gone. Not `mktemp`: that name would stay inside the shell.
    const tmp = `/tmp/redlog-exit-probe-${token}-${process.pid}-${Date.now()}`

    afterAll(async () => {
      await collector?.close()
      await runInShell(kind.target!, `rm -rf '${tmp}'`)
    })

    beforeAll(async () => {
      const target = kind.target!
      // RedLog has to look reachable, or no command is relayed at all.
      collector = await startCollector(token)
      const report = await runZsh(target, {
        shellKind: kind.name,
        rc: [
          `mkdir -p '${tmp}'`,
          `export TMPDIR='${tmp}'`,
          ...(kind.own ? [`trap 'touch "${tmp}/operator-exit-ran"' EXIT`] : []),
          `source ${hookPath(target, kind.hook)}`
        ].join('\n'),
        commands: [
          // A relayed command that finishes: its directory is there while it
          // runs and gone by the next prompt. This is the control — a leak
          // that included this one would be a different bug.
          'ls -d "$TMPDIR"/redlog-relay.* | sed "s/^/DURING /"'
        ],
        redlog: { port: collector.port, token },
        timeoutSeconds: 40
      })
      ok = report.ok
      error = report.error ?? ''
      during = report.steps[0]?.output ?? ''
      // The driver has typed `exit` and the shell has returned.
      const left = await runInShell(target, `ls -1 '${tmp}' | sed 's/^/LEFT /'`)
      after = left.stdout
    }, 300_000)

    it('relays an ordinary command into a directory of its own', () => {
      expect(ok, error).toBe(true)
      expect(during).toMatch(/DURING .*redlog-relay\.\d+\./)
    })

    it('leaves no relay directory behind when the shell is exited', () => {
      expect(after).not.toMatch(/redlog-relay/)
    })

    if (kind.own) {
      it('still runs the operator’s own EXIT trap', () => {
        expect(after).toContain('LEFT operator-exit-ran')
      })
    }
  })
}
