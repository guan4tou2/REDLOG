import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runZsh, startCollector, hookPath, type ShellTarget, type ZshReport } from './helpers/zsh-pty'

// The bash twin of zsh-transparency.pty.test.ts: is the shell the same shell
// with the adapter loaded? Same keystrokes twice, bare and adapted, compared.
// (zsh original follows.)
//
// Spec 052 / issue #288: is the shell the same shell with the adapter loaded?
//
// The relay's promise (spec.md FR-006, research.md D1) is that it records a
// command without changing what the operator experiences. Nothing had checked
// that against a real terminal for anything but `nc`, and the issue lists what
// an operator notices first: `ls` colour and columns, `isatty`, window size,
// UTF-8, Ctrl-C, Ctrl-Z, aliases.
//
// The method is the nc test's: the same keystrokes twice, once in a bare zsh
// and once with the adapter, and the observable results compared. A bare run
// is the oracle because "what a terminal should do" is not something a string
// can say, while "what it does without RedLog" is.
//
// What this found, the first time it was run: the relay handed every command a
// PIPE for stdout and stderr, so a relayed `ls` printed one name per line with
// no colour, `[ -t 1 ]` was false, and `os.get_terminal_size()` raised ENOTTY.
// The same keystrokes in a bare shell did none of that. Nothing else in the
// suite could have said so — every assertion was about what was recorded, and
// the record was fine. Those three are now EQUAL assertions: the relay gives
// the command a pseudo-terminal for each of the two streams instead
// (hooks/redlog-relay.py `pty`), and what is stored is the cleaned text.

const target: ShellTarget = { prefix: [], toShellPath: (p) => p, label: 'local bash' }
const describeShell = process.platform === 'win32' ? describe.skip : describe

const ROWS = 30
const COLS = 100

// A real directory colour, set explicitly. Left to the environment, whether
// `ls` colours anything depends on a dircolors file the test machine may not
// have, and the comparison would then be about the machine.
//
// Test commands stay short: past the terminal width zle redraws the line and
// the driver's echo-stripping no longer recognises it. The probes live in files
// the rc writes instead.
const RC = [
  `export LS_COLORS='di=01;34'`,
  `export CLICOLOR=1 LSCOLORS=exfxcxdxbxegedabagacad`,
  `alias ll='ls -l'`,
  process.platform === 'darwin' ? `alias ls='ls -G'` : `alias ls='ls --color=auto'`,
  `cat > $HOME/isatty.sh <<'EOF'`,
  `for n in 0 1 2; do if [ -t $n ]; then printf "fd$n=tty "; else printf "fd$n=pipe "; fi; done; echo`,
  `EOF`,
  `export PAGER=less`,
  `unset GIT_PAGER`,
  `cat > $HOME/pager.sh <<'EOF'`,
  `seq 1 200 | \${PAGER:-less}`,
  `EOF`,
  `cat > $HOME/winsz.py <<'EOF'`,
  `import os; print(os.get_terminal_size().columns)`,
  `EOF`,
  ''
].join('\n')
const DIR_COLOUR = process.platform === 'darwin' ? '\u001b[34m' : '\u001b[01;34m'

/** Straight-line commands: type, wait for the prompt. */
const PLAIN = [
  'sh $HOME/isatty.sh',                                       // 0
  'ls -d /usr /etc /var',                                     // 1  aliased to --color=auto
  'ls /usr',                                                  // 2  columns or one per line
  'stty size',                                                // 3  reads stdin
  'tput cols',                                                // 4
  'python3 $HOME/winsz.py 2>&1 | tail -1',                    // 5  a pipeline: the relay stands down
  'python3 $HOME/winsz.py',                                   // 6  reads fd 1
  `printf 'caf\\xc3\\xa9 \\xe4\\xbd\\xa0\\xe5\\xa5\\xbd\\n'`,   // 7  UTF-8
  `sh -c 'exit 7'`,                                           // 8
  'echo rc=$?',                                               // 9
  'll -d /usr',                                               // 10 alias
  'printf "a\\nb\\n" | wc -l',                                // 11 pipeline
  'echo to-a-file > $HOME/redirected.txt; cat $HOME/redirected.txt', // 12
  'sh -c "echo out; echo err >&2" 2>&1',                      // 13
  'sh -c "echo out; echo err >&2"',                           // 14 recorded apart
  `printf 'one\\rtwo\\rthree\\n'`,                            // 15 a redrawn line
  `printf 'x\\ny\\n'`                                         // 16 plain newlines
]

// A command that starts a pager of its own (`git log`, `man`). Bare, the pager
// draws a page and waits for a key. Under the relay it is switched off — see
// the LIMIT block — so the same keystrokes are different lists.
// A redirection makes the relay stand down, so this line is NOT diverted and
// reads the pager settings as the operator has them. `echo $PAGER` on its own
// is diverted, and so sees what the relay set — see the LIMIT block.
const READ_PAGERS = 'echo pager=$PAGER git=${GIT_PAGER-unset} > $HOME/p.txt; cat $HOME/p.txt'
const PAGER_BARE = [
  { line: 'sh $HOME/pager.sh', until: 'pager.sh' },
  { sh: 'sleep 2' },
  { raw: 'q' },
  READ_PAGERS,
  'echo pager=$PAGER'
] as const
const PAGER_ADAPTED = [
  'sh $HOME/pager.sh',
  READ_PAGERS,
  'echo pager=$PAGER'
] as const

const SIGNALS = [
  // Ctrl-C on a command the relay holds. The line's own echo contains the
  // text waited for, so this returns as soon as it is typed; waitFor then
  // holds the interrupt until `sleep` is actually running.
  { line: 'sleep 31', until: 'sleep 31' },
  { foreground: 'sleep' },
  { raw: '\u0003' },
  'echo rc=$?',
  // Ctrl-Z and fg: a command suspended and resumed still finishes, and its
  // output still reaches the terminal after the resume.
  { line: `sh -c 'sleep 4; echo after-resume'`, until: 'after-resume' },
  { foreground: 'sh' },
  { raw: '\u001a' },
  'jobs',
  { line: 'fg', until: 'after-resume' },
  { prompt: true as const },
  'echo rc=$?'
] as const

describeShell(`terminal transparency, with and without the adapter (${target.label})`, () => {
  let collector: Awaited<ReturnType<typeof startCollector>>
  const token = 'transparency-token'
  const out: Record<string, ZshReport> = {}

  const adapterRc = (): string => `${RC}source ${hookPath(target, 'shell-bash-hook.sh')}`
  const run = (rc: string, commands: ReadonlyArray<string | object>, adapter: boolean): Promise<ZshReport> =>
    runZsh(target, {
      shellKind: 'bash',
      rc,
      commands: [...commands] as never,
      redlog: adapter ? { port: collector.port, token } : undefined,
      winsize: [ROWS, COLS],
      keepRaw: true,
      timeoutSeconds: 30,
      totalTimeoutSeconds: 180
    })

  beforeAll(async () => {
    collector = await startCollector(token)
    out.plainBare = await run(RC, PLAIN, false)
    out.plainAdapted = await run(adapterRc(), PLAIN, true)
    out.pagerBare = await run(RC, PAGER_BARE, false)
    out.pagerAdapted = await run(adapterRc(), PAGER_ADAPTED, true)
    out.signalBare = await run(RC, SIGNALS, false)
    out.signalAdapted = await run(adapterRc(), SIGNALS, true)
  }, 900_000)
  afterAll(async () => { await collector?.close() })

  // bash 3.2 prints `bash: child setpgid (N to N): Operation not permitted` on
  // its own, now and then, on a pty — measured in a bare shell with no adapter,
  // about once in sixty commands. It is not the adapter's and not a difference
  // to assert on, so it is taken out of what is compared.
  const text = (r: ZshReport, i: number): string => (r.steps[i]?.output ?? '')
    .replace(/^bash: child setpgid.*$/gm, '').trim()
  const raw = (r: ZshReport, i: number): string => r.steps[i]?.raw ?? ''

  it('the baselines ran — otherwise every comparison below is vacuous', () => {
    for (const r of [out.plainBare, out.signalBare]) expect(r.ok, r.error).toBe(true)
    expect(text(out.plainBare, 0)).toBe('fd0=tty fd1=tty fd2=tty')
    expect(raw(out.plainBare, 1), 'the bare shell did not colour ls, so colour proves nothing here').toContain(DIR_COLOUR)
  })

  describe('EQUAL — the adapter must not change these', () => {
    let a: ZshReport
    let b: ZshReport
    beforeAll(() => { a = out.plainAdapted; b = out.plainBare })

    it('the adapted shell ran every command', () => {
      expect(a.ok, a.error).toBe(true)
    })

    it('stdout and stderr are terminals, as they are in a bare shell', () => {
      // A pipe here was the defect: `[ -t 1 ]` false, so every tool that
      // decides its formatting from it decided differently (#288).
      expect(text(a, 0)).toBe(text(b, 0))
    })

    it('`ls` colours and lays out columns as it does without RedLog', () => {
      expect(raw(b, 1)).toContain(DIR_COLOUR)
      expect(raw(a, 1)).toContain(DIR_COLOUR)
      // Several names to a line, in the same columns.
      expect(text(b, 2).split('\n').length).toBeLessThan(5)
      expect(text(a, 2)).toBe(text(b, 2))
    })

    it('a program that asks fd 1 for the window size gets the real one', () => {
      expect(text(b, 6)).toBe(String(COLS))
      const diagnostic = JSON.stringify({ steps: a.steps.slice(5, 8), events: collector.events.filter(e => String(e.data.command).includes('winsz.py')) })
      expect(text(a, 6), diagnostic).toBe(text(b, 6))
      // And the same program in a pipeline, which the relay stands down for.
      expect(text(a, 5), diagnostic).toBe(text(b, 5))
    })

    it('the terminal size the command can read from stdin, and from tput', () => {
      expect(text(b, 3)).toBe(`${ROWS} ${COLS}`)
      expect(text(a, 3)).toBe(text(b, 3))
      expect(text(a, 4)).toBe(text(b, 4))
    })

    it('UTF-8 passes through byte for byte', () => {
      expect(text(b, 7)).toBe('café 你好')
      expect(text(a, 7)).toBe(text(b, 7))
    })

    it('the exit status the shell sees', () => {
      expect(text(a, 9)).toBe('rc=7')
      expect(text(a, 9)).toBe(text(b, 9))
    })

    it('aliases still apply', () => {
      expect(text(a, 10)).toBe(text(b, 10))
      expect(text(a, 10)).toMatch(/^d/)
    })

    it('a pipeline and a redirection behave as without it', () => {
      expect(text(a, 11)).toBe(text(b, 11))
      expect(text(a, 12)).toBe(text(b, 12))
      expect(text(a, 13)).toBe(text(b, 13))
    })
  })

  describe('RECORD — what is stored is readable and still tells the streams apart', () => {
    const endOf = (needle: string): Record<string, unknown> => {
      const start = collector.events.find((e) => e.data.subtype === 'command_start'
        && String(e.data.command ?? '') === needle)
      expect(start, `no command_start for ${needle}`).toBeTruthy()
      const end = collector.events.find((e) => e.data.subtype === 'command_end'
        && e.data.command_id === start!.data.command_id)
      expect(end, `no command_end for ${needle}`).toBeTruthy()
      return end!.data
    }

    it('keeps colour on the screen and out of the stored text', () => {
      const end = endOf(PLAIN[1])
      // The bytes the terminal was sent had colour in them (asserted above);
      // the stored copy does not, because a reader of the record wants names.
      expect(String(end.stdout)).toBe(`${text(out.plainBare, 1)}\n`)
      expect(end).toMatchObject({ completeness: 'complete', output_disposition: 'captured' })
    })

    it('keeps stdout and stderr apart — a terminal for each, not one terminal for both', () => {
      // FR-005. One pty would be the terminal's own merge, and a record that
      // claimed to have separated what it merged would be a lie.
      const end = endOf(PLAIN[14])
      expect(String(end.stdout)).toBe('out\n')
      expect(String(end.stderr)).toBe('err\n')
    })

    it('stores the line a progress bar ended on, not every redraw of it', () => {
      expect(String(endOf(PLAIN[15]).stdout)).toBe('three\n')
    })

    it('counts the bytes the command wrote, not the ones the pty added', () => {
      // The slave turns \n into \r\n unless told not to, and the cleaned text
      // cannot show it — cleaning folds \r\n back. The byte count can: it is
      // of everything that passed (Stream's contract), so six here would be
      // the pty's carriage returns being counted as the command's output.
      const end = endOf(PLAIN[16])
      expect(String(end.stdout)).toBe('x\ny\n')
      expect(end.stdout_bytes).toBe(4)
    })
  })

  describe('LIMIT — differences that are chosen, and written down', () => {
    it('a pager started by a relayed command is switched off for that command', () => {
      // Not transparent, on purpose. With a terminal on stderr, `less` takes
      // its keyboard from it, and that terminal is the relay's, which nobody
      // types into: the pager draws a page and never reads a key. Measured —
      // the first version of the pty relay hung on `git log` exactly this way.
      // Switching the pagers off gives what a pipe used to give.
      const bare = out.pagerBare
      const adapted = out.pagerAdapted
      expect(bare.ok, bare.error).toBe(true)
      expect(text(bare, 2), 'the bare shell did not page, so there is nothing to compare').toMatch(/\n?1\n2\n3/)
      expect(adapted.ok, adapted.error, 'the pager held the prompt').toBe(true)
      // The whole listing is there, not a first page.
      expect(text(adapted, 0)).toContain('\n200')
      expect(String(collector.events.find((e) => e.data.subtype === 'command_end'
        && e.data.command === 'sh $HOME/pager.sh')?.data.stdout)).toContain('200')
    })

    it('puts the pager settings back at the prompt, as the operator had them', () => {
      expect(text(out.pagerAdapted, 1)).toBe('pager=less git=unset')
      expect(text(out.pagerAdapted, 1)).toBe(text(out.pagerBare, 3))
    })

    it('but a command line that EXPANDS the pager variables sees the switched-off value', () => {
      // preexec runs before the line is expanded, so `echo $PAGER` reads what
      // the relay has just set. A limit of doing it in the shell's own
      // environment — a command's environment cannot be changed from preexec.
      expect(text(out.pagerBare, 4)).toBe('pager=less')
      expect(text(out.pagerAdapted, 2)).toBe('pager=cat')
    })
  })

  describe('signals', () => {
    it('Ctrl-C ends a relayed command and returns the prompt with the same status', () => {
      const a = out.signalAdapted
      const b = out.signalBare
      expect(a.ok, a.error).toBe(true)
      expect(text(b, 3)).toBe('rc=130')
      expect(text(a, 3)).toBe('rc=130')
    })

    it('Ctrl-Z suspends a relayed command, `jobs` lists it, `fg` finishes it', () => {
      const a = out.signalAdapted
      const b = out.signalBare
      expect(text(b, 7)).toMatch(/suspended|stopped/i)
      expect(text(a, 7)).toMatch(/suspended|stopped/i)
      // `fg` returns when its own echo appears, so the output that arrives
      // AFTER the resume lands in the prompt wait that follows.
      expect(text(a, 8) + text(a, 9)).toContain('after-resume')
      expect(text(b, 8) + text(b, 9)).toContain('after-resume')
      expect(text(a, 10)).toBe(text(b, 10))
    })
  })
})
