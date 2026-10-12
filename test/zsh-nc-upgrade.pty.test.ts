import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { findShellTarget, runZsh, startCollector, hookPath, type ShellTarget, type ZshReport } from './helpers/zsh-pty'

// Spec 052 T044 / SC-004, step (c) of quickstart.md — the line this feature
// must not cross.
//
// An operator who catches a reverse shell does the same thing every time:
//
//     nc -lvnp 4444          wait for the callback
//     Ctrl-Z                 suspend nc
//     stty raw -echo; fg     put the local terminal in raw mode, resume nc
//
// and has, at that point, a fully interactive shell on the target. It is the
// most fragile thing an operator does and it happens on a machine that may
// have taken days to reach. A logger that sits in `preexec` and holds the
// shell's descriptors is exactly the kind of thing that could break it, which
// is why the spec makes `nc` a class RedLog leaves alone (FR-025) and why
// quickstart.md says a run that cannot complete this step is not a verified
// feature, whatever the unit suite says.
//
// What this is NOT: a substitute for doing it on a real Kali VM with a real
// RedLog. It proves the adapter behaves on zsh 5.9 and a real pty, with the
// kernel's own line discipline turning Ctrl-Z into SIGTSTP. It does not prove
// the packaged build, the installer, or anything about RedLog's own window.
//
// The method is a DIFFERENTIAL one. "The upgrade works" is not something a
// string comparison can say, but "the upgrade works exactly as it does
// without RedLog installed" is — so the same keystrokes run twice, once in a
// bare zsh and once with the adapter, and the observable results are compared.

const target: ShellTarget | null = findShellTarget()

// Kali's `nc` is the traditional netcat (v1.10), and `nc -lvnp PORT` is that
// flavour's syntax. The OpenBSD one most CI images ship refuses it
// ("cannot use -p and -l"), prints a differently-cased banner, and handles the
// peer hanging up differently — so on that flavour this would fail for reasons
// that say nothing about RedLog. It is skipped there, with the reason, rather
// than ported on a guess: the delivery target is Kali, and a second flavour
// that nobody has run is a test that is green by luck.
function hasTraditionalNc(t: ShellTarget | null): boolean {
  if (!t) return false
  const argv = [...t.prefix, 'sh', '-c', 'nc -h 2>&1 | head -2']
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
    const text = `${out.stdout}${out.stderr}`.trim()
    // Silence is a probe that failed, not an answer — through WSL it is the
    // interop service refusing a session, and reading that as "not
    // traditional" would skip the whole file and report green. Only an actual
    // banner can say which flavour this is.
    if (text) return /v1\.10/.test(text)
  }
  return false
}

const describeShell = hasTraditionalNc(target) ? describe : describe.skip

const PORT = 4444

/** The keystrokes, exactly as the quickstart gives them. */
const UPGRADE = [
  'stty -g',
  { line: `nc -lvnp ${PORT}`, until: 'listening on' },
  { raw: '\u001a' },                                   // Ctrl-Z
  'jobs',
  { line: 'stty raw -echo; fg', until: 'continued' },
  // What nc's descriptors ARE, read from the kernel rather than inferred from
  // what the terminal printed. A relayed command has its stdout and stderr
  // replaced by pipes into the relay; a native one keeps the terminal. That
  // difference is invisible to every behavioural check above it — suspend,
  // resume and the peer's data all work either way — and it is the whole
  // reason `nc` is in the native class: with a pipe in the way, a relay that
  // dies (an OOM kill, an operator's `pkill python3`) hands nc a broken pipe,
  // and the reverse shell that took days to catch goes with it.
  { sh: 'p=$(pgrep -xn nc); for f in 0 1 2; do readlink /proc/$p/fd/$f; done' },
  // The other end of the reverse shell: connect, say something.
  { peer: { port: PORT, send: 'from-the-other-end\n', hold: 0.6 } },
  // Ended from OUTSIDE the terminal rather than by the peer hanging up.
  //
  // Hanging up is what an operator would do, and it is not usable here. On
  // this WSL2 host, a bare zsh with no adapter loaded fails to get nc to exit
  // when the peer connects two seconds after `fg` — three runs of three, with
  // nothing of RedLog's anywhere in the shell — and then works at five seconds
  // and at zero. The socket sits ESTABLISHED on nc's side with the peer's FIN
  // unacknowledged. That is a kernel/loopback/timing matter, and a test that
  // waited on it would be a coin flip that blames whichever side was loaded.
  //
  // The claim being tested does not need it. "The connection survived the
  // suspend and the resume" is proved the moment the resumed nc prints what
  // the peer sent; what remains is getting the prompt back.
  { sh: 'sleep 0.5; pkill -x nc || true' },
  { prompt: true as const },
  'stty -g'
] as const

interface Observed {
  suspended: boolean
  jobsShowsStopped: boolean
  continued: boolean
  receivedFromPeer: boolean
  promptReturned: boolean
  sttyBefore: string
  sttyAfter: string
  /** What fd 0, 1 and 2 of the resumed nc are: `tty`, `pipe` or something else. */
  ncFds: string[]
}

const kindOf = (target: string): string =>
  target.startsWith('/dev/pts/') ? 'tty' : target.startsWith('pipe:') ? 'pipe' : target || 'unreadable'

function observe(report: ZshReport): Observed {
  const step = (i: number): string => report.steps[i]?.output ?? ''
  return {
    suspended: /suspended/.test(step(2)),
    jobsShowsStopped: /suspended/.test(step(3)) && /nc/.test(step(3)),
    continued: /continued/.test(step(4)),
    ncFds: step(5).trim().split('\n').map((l) => kindOf(l.trim())),
    // What nc printed lands in the pty buffer and is read by the NEXT step
    // that reads the pty — the prompt wait, not the out-of-band `sh`.
    receivedFromPeer: /from-the-other-end/.test(step(8)),
    promptReturned: report.ok,
    sttyBefore: step(0).trim(),
    sttyAfter: step(9).trim()
  }
}

describeShell(`the nc upgrade, with and without the adapter (${target?.label ?? 'no zsh reachable'})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  let bare: ZshReport
  let adapted: ZshReport
  const token = 'nc-upgrade-token'

  beforeAll(async () => {
    collector = await startCollector(token)
    // Sequential, not parallel: both bind :4444, and the WSL lock would
    // serialise them anyway.
    bare = await runZsh(target!, {
      rc: '# no RedLog adapter',
      commands: [...UPGRADE], timeoutSeconds: 30, totalTimeoutSeconds: 180
    })
    adapted = await runZsh(target!, {
      rc: `source ${hookPath(target!, 'shell-zsh-hook.zsh')}`,
      commands: [...UPGRADE],
      redlog: { port: collector.port, token },
      timeoutSeconds: 30,
      totalTimeoutSeconds: 180
    })
  }, 600_000)
  afterAll(async () => { await collector?.close() })

  it('the baseline works — otherwise the comparison proves nothing', () => {
    // If the bare shell cannot do the upgrade here, "the adapter does not
    // break it" is vacuously true, and a green result would be a lie.
    expect(bare.ok, bare.error).toBe(true)
    const o = observe(bare)
    expect(o.suspended, 'Ctrl-Z did not suspend nc in a bare zsh').toBe(true)
    expect(o.jobsShowsStopped).toBe(true)
    expect(o.continued, 'fg did not resume it').toBe(true)
    expect(o.receivedFromPeer, 'nc did not receive what the peer sent').toBe(true)
  })

  it('suspends, resumes and carries the connection with the adapter loaded', () => {
    expect(adapted.ok, adapted.error).toBe(true)
    const o = observe(adapted)
    expect(o.suspended, 'Ctrl-Z did not suspend nc under the adapter').toBe(true)
    expect(o.jobsShowsStopped).toBe(true)
    expect(o.continued, 'fg did not resume it').toBe(true)
    // The point of the whole exercise: the job that was suspended and
    // resumed is still holding a working connection.
    expect(o.receivedFromPeer, 'the resumed nc lost its connection').toBe(true)
    expect(o.promptReturned).toBe(true)
  })

  it('leaves nc holding the terminal itself, not a pipe into the relay', () => {
    // The structural claim behind FR-025, and the one assertion in this file
    // that goes red if `nc` is ever moved out of the native class — every
    // behavioural check above passes with a relayed nc, which was found by
    // moving it and watching them all stay green.
    const o = observe(adapted)
    expect(o.ncFds, 'could not read nc’s descriptors').toHaveLength(3)
    expect(o.ncFds, `nc's fd 0/1/2 are ${o.ncFds.join('/')}`).toEqual(['tty', 'tty', 'tty'])
    // And that is what a bare shell gives it, so nothing was lost.
    expect(observe(bare).ncFds).toEqual(['tty', 'tty', 'tty'])
  })

  it('leaves the terminal exactly as the bare shell leaves it', () => {
    // research.md O1 measured this for a paged command; this is the same
    // claim for the case that matters. `stty sane` is not a restore — the
    // settings have to be what they were.
    const a = observe(adapted)
    const b = observe(bare)
    expect(a.sttyBefore, 'no stty -g reading').toBeTruthy()
    expect(a.sttyBefore).toBe(b.sttyBefore)
    expect(a.sttyAfter).toBe(b.sttyAfter)
  })

  it('the same observable result, step for step', () => {
    // One assertion over the lot, so that a divergence anywhere names itself.
    const a = observe(adapted)
    const b = observe(bare)
    expect({ ...a, sttyBefore: '', sttyAfter: '' }).toEqual({ ...b, sttyBefore: '', sttyAfter: '' })
  })

  it('records nc as a command and says its session was not captured', () => {
    const start = collector.events.find((e) => e.data.subtype === 'command_start'
      && String(e.data.command ?? '').startsWith('nc '))
    const end = collector.events.find((e) => e.data.subtype === 'command_end'
      && String(e.data.command ?? '').startsWith('nc '))
    expect(start, 'nc is missing from the record entirely').toBeTruthy()
    // `relayed` here would mean the relay was holding nc's descriptors, which
    // is the failure this class exists to prevent.
    expect(start!.data.class, 'nc was relayed').toBe('native')
    expect(end, 'nc has no command_end').toBeTruthy()
    expect(end!.data).toMatchObject({
      completeness: 'metadata-only',
      output_disposition: 'interactive'
    })
    // An absence that says it is an absence, not an empty body that reads as
    // "this command printed nothing".
    expect(end!.data.stdout).toBeUndefined()
    expect(end!.data.stdout_ref).toBeUndefined()
  })
})
