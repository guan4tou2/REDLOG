import fs from 'fs'
import readline from 'readline'

// Slice an asciinema .cast file into the output that fell inside a given
// wall-clock window, and return both the raw slice and an ANSI-stripped text
// form. Used by the timeline "replay this command" flow: given a command_end
// event's terminalId + timestamps, we look up the session's castPath, then
// pull out only the 'o' (output) events that were emitted while the command
// ran. No stdout is stored in the chain — the .cast on disk stays the source
// of truth.
//
// Cast format (asciinema v2, one JSON per line):
//   {"version":2,"width":..,"height":..,"timestamp":<unix-sec>,...}
//   [<sec-from-start>, "o", "<text bytes incl. ANSI>"]
//   ...
//
// startMs / endMs are absolute JS timestamps (Date.now() semantics). The
// header's `timestamp` is unix seconds and marks the cast's t=0.
//
// v0.6.95 P1-11: this used to `fs.readFileSync` the whole file, `split('\n')`
// it into an in-memory Array<string>, and JSON.parse every line even when the
// window was seconds long. Peak memory ~4x the file size — two concurrent
// 50MB replays cracked the 8GB Electron cap. The rewrite streams the file
// line-by-line via readline, only keeping events inside [startMs, endMs].
// The function is now async (`Promise<CastSlice | null>`); callers `await`
// it. Same 50MB cap still bails early — anything above that is either an
// attacker-planted file or a corrupted install.

// Anti-DoS cap: don't read casts bigger than this. 50 MB matches the
// per-session cast cap in terminal-manager, so under normal operation we
// won't hit it. Larger files skip.
const MAX_CAST_BYTES = 60 * 1024 * 1024

// Strip ANSI CSI/OSC/single-char escapes so the returned `text` field is
// grep-friendly and renders sanely in an event detail panel. The raw slice
// keeps every byte for asciinema replay.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export interface CastSlice {
  events: Array<[number, 'o', string]>   // asciinema-format events (relative sec)
  text: string                            // concatenated + ANSI-stripped output
  bytes: number                           // raw output byte count (pre-strip)
  truncated: boolean                      // window included events past MAX_CAST_BYTES
  castStartMs: number                     // wall-clock t=0 of the cast
}

export async function readCastSlice(castPath: string, startMs: number, endMs: number): Promise<CastSlice | null> {
  let stat: fs.Stats
  try { stat = fs.statSync(castPath) } catch { return null }
  // v0.6.93 P0-G: bail on oversized files rather than slurping them into RAM.
  // `MAX_CAST_BYTES` (50MB) mirrors terminal-manager's write-time cap.
  if (stat.size > MAX_CAST_BYTES) return null

  // v0.6.95 P1-11: stream the file. `crlfDelay: Infinity` makes readline
  // treat "\r\n" as a single line terminator so Windows-authored casts don't
  // confuse the JSON parser. Errors on the stream (permission denied mid-read,
  // disk hiccup) resolve to null — the caller sees "failed to read cast".
  const stream = fs.createReadStream(castPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let header: { timestamp?: number } | null = null
  const events: Array<[number, 'o', string]> = []
  let bytes = 0
  let castStartMs = 0
  let stopped = false
  let streamError: Error | null = null

  stream.on('error', (err) => { streamError = err })

  try {
    for await (const line of rl) {
      if (streamError) break
      if (!line) continue
      if (!header) {
        try { header = JSON.parse(line) } catch { rl.close(); stream.destroy(); return null }
        if (!header || typeof header.timestamp !== 'number') { rl.close(); stream.destroy(); return null }
        castStartMs = header.timestamp * 1000
        continue
      }
      let ev: unknown
      try { ev = JSON.parse(line) } catch { continue }
      if (!Array.isArray(ev) || ev.length < 3) continue
      const relSec = ev[0] as number
      const type = ev[1] as string
      const data = ev[2] as string
      if (type !== 'o' || typeof relSec !== 'number' || typeof data !== 'string') continue
      const absMs = castStartMs + relSec * 1000
      if (absMs < startMs) continue
      if (absMs > endMs) {
        // Stop reading further — the file is time-ordered so nothing later
        // will fall back inside the window. Destroying the stream cancels
        // outstanding I/O so we don't pay for bytes we'll never look at.
        stopped = true
        rl.close()
        stream.destroy()
        break
      }
      events.push([relSec, 'o', data])
      bytes += data.length
    }
  } catch { /* readline aborted (stream.destroy above) — fall through */ }

  if (streamError && !stopped) return null
  if (!header) return null

  const joined = events.map((e) => e[2]).join('')
  return { events, text: stripAnsi(joined), bytes, truncated: false, castStartMs }
}
