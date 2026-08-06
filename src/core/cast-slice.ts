import fs from 'fs'

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

export function readCastSlice(castPath: string, startMs: number, endMs: number): CastSlice | null {
  let stat: fs.Stats
  try { stat = fs.statSync(castPath) } catch { return null }
  // v0.6.93 P0-G: `oversized` used to just pick an encoding flag but still
  // slurped the full file into memory — a 500MB cast OOM'd the main process.
  // Now: bail. `MAX_CAST_BYTES` (50MB) is the same cap terminal-manager
  // enforces at write time; anything beyond that is either an attacker-
  // planted file or a corrupted install.
  if (stat.size > MAX_CAST_BYTES) return null
  const raw = fs.readFileSync(castPath, 'utf8')

  const lines = raw.split('\n')
  if (lines.length === 0) return null
  let header: { timestamp?: number } | null = null
  try { header = JSON.parse(lines[0]) } catch { return null }
  if (!header || typeof header.timestamp !== 'number') return null
  const castStartMs = header.timestamp * 1000

  const events: Array<[number, 'o', string]> = []
  let bytes = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }
    if (!Array.isArray(ev) || ev.length < 3) continue
    const relSec = ev[0] as number
    const type = ev[1] as string
    const data = ev[2] as string
    if (type !== 'o' || typeof relSec !== 'number' || typeof data !== 'string') continue
    const absMs = castStartMs + relSec * 1000
    if (absMs < startMs) continue
    if (absMs > endMs) break
    events.push([relSec, 'o', data])
    bytes += data.length
  }

  const oversized = false  // v0.6.93: files exceeding MAX_CAST_BYTES bail early above
  const joined = events.map((e) => e[2]).join('')
  return { events, text: stripAnsi(joined), bytes, truncated: oversized, castStartMs }
}
