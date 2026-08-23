// PowerShell Start-Transcript parsing (docs/DESIGN-core-and-capture.md §2.3).
//
// Windows capture was thin: shell-hook.ps1 records a command, its exit code and
// duration, but the OUTPUT only when the operator remembers to prefix with
// `Redlog-Run` — note-taking discipline, the exact thing §1's second half
// exists to remove. The decision was `Start-Transcript` plus a tailer: PowerShell
// writes a full session transcript to a file, and RedLog follows it, the same
// shape as the agent tailer (something else writes, we read).
//
// This is the pure half — turning one transcript's text into structured command
// records. It is where the format quirks live (the banner blocks, the prompt
// shape, output that spans many lines), so it is isolated from the file-follow
// I/O and unit-tested without Windows, the same split connection-table.ts uses.
//
// ── Conservative by construction (§2.2) ─────────────────────────────────────
//
// The parser only treats a line as a command when it is an unambiguous prompt —
// `PS <path>> <command>`. Everything between one prompt and the next (or the
// end banner) is that command's output. It never guesses inside output, and a
// transcript region it cannot read as a prompt produces no command rather than
// a fabricated one: a command on the timeline the operator never typed is worse
// than a gap, because the record's worth is that it can be trusted.

export interface TranscriptCommand {
  /** Working directory shown in the prompt. */
  cwd: string
  /** The command line the operator entered. */
  command: string
  /** Everything printed before the next prompt, trimmed. May be empty. */
  output: string
}

export interface ParsedTranscript {
  /** Unix ms of the transcript's "Start time", or null if unparsable. */
  startedAtMs: number | null
  username: string | null
  host: string | null
  commands: TranscriptCommand[]
}

// The banner delimiter Start-Transcript writes around its header and footer.
const BANNER = /^\*{6,}\s*$/

// `PS C:\Users\x> whoami` — the default prompt. Also accepts a bare `PS>` and
// custom prompts that still end in `PS <something>> `. The command is whatever
// follows the `> `. Deliberately strict: a line that is not this shape is
// output, never a command.
const PROMPT = /^PS ([^\n>]*)>\s?(.*)$/

/** Parse a Start-Transcript header line like `Start time: 20260823120000`. */
function parseStartTime(line: string): number | null {
  const m = /^Start time:\s*(\d{14})$/.exec(line.trim())
  if (m) {
    const s = m[1]
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`
    const t = Date.parse(iso)
    return Number.isNaN(t) ? null : t
  }
  // Some locales write a human date; try Date.parse as a fallback, but only
  // accept it if it actually parses — a wrong timestamp is worse than none.
  const m2 = /^Start time:\s*(.+)$/.exec(line.trim())
  if (m2) {
    const t = Date.parse(m2[1])
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function parseStartTranscript(text: string): ParsedTranscript {
  // Normalise CR, CRLF and any stray CR to LF first: a trailing \r left on
  // a prompt line makes the prompt regex's `$` miss and the command vanish.
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let startedAtMs: number | null = null
  let username: string | null = null
  let host: string | null = null

  const commands: TranscriptCommand[] = []
  let current: TranscriptCommand | null = null
  let outputLines: string[] = []
  let inBanner = false

  const flush = (): void => {
    if (current) {
      current.output = outputLines.join('\n').trim()
      commands.push(current)
      current = null
      outputLines = []
    }
  }

  for (const line of lines) {
    if (BANNER.test(line)) {
      // A banner ends any command in progress and toggles header/footer mode.
      flush()
      inBanner = !inBanner
      continue
    }
    if (inBanner) {
      // Header/footer metadata lines.
      if (startedAtMs === null) { const t = parseStartTime(line); if (t !== null) startedAtMs = t }
      const u = /^Username:\s*(.+)$/.exec(line.trim()); if (u) username = u[1]
      const h = /^(?:Machine|RunAs User|Host Application):\s*(.+)$/.exec(line.trim())
      if (h && /^Machine:/.test(line.trim())) host = h[1]
      continue
    }
    const p = PROMPT.exec(line)
    if (p) {
      // A new prompt closes the previous command's output and starts a new one.
      flush()
      const command = p[2].trim()
      // A prompt with no command (the operator just pressed Enter) is not an
      // event — skip it rather than emit an empty command.
      if (command) current = { cwd: p[1].trim(), command, output: '' }
      continue
    }
    // Any other line is output for the command in progress. Lines before the
    // first prompt (stray, or post-header noise) have no owner and are dropped.
    if (current) outputLines.push(line)
  }
  flush()

  return { startedAtMs, username, host, commands }
}
