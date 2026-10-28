import fs from 'fs'
import readline from 'readline'
import path from 'path'

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
// Reads stream through every part but retain only a bounded preview. Saved
// evidence is never limited by this reader budget. Each physical part is
// bounded separately by TerminalRecording.
const MAX_CAST_BYTES = 60 * 1024 * 1024

// Strip ANSI CSI/OSC/DCS/APC/PM/SOS and single-char escapes so the returned `text` field is
// grep-friendly and renders sanely in an event detail panel. The raw slice
// keeps every byte for asciinema replay.
//
// String-type sequences (OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`) are removed
// whole, payload included. The single-char rule below also matches `ESC P`, so
// without the string rule only the two introducer bytes went and the payload
// stayed in the output: Warp's shell integration sends `ESC P $d<hex> ESC \`
// and the hex showed up as command stdout.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

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

async function readSingleCastSlice(castPath: string, startMs: number, endMs: number, budget: number): Promise<CastSlice | null> {
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
  let previewCut = false
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
      try { ev = JSON.parse(line) } catch { previewCut = true; continue }
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
      if (bytes + Buffer.byteLength(data) > budget) { previewCut = true; break }
      events.push([relSec, 'o', data])
      bytes += Buffer.byteLength(data)
    }
  } catch { /* readline aborted (stream.destroy above) — fall through */ }

  if (streamError && !stopped) return null
  if (!header) return null

  const joined = events.map((e) => e[2]).join('')
  return { events, text: stripAnsi(joined), bytes, truncated: previewCut, castStartMs }
}

/** v0.9.6 (T2): read a cast by BYTE RANGE instead of time window.
 *
 *  `command_end` now carries `io: {off, len}` — the exact span of the cast
 *  that this command produced, captured from the live write position at
 *  O(1) cost. Reading that span is O(len); the time-window path handles
 *  sessions where the command pair could not be bracketed.
 *
 *  The range may start or end mid-line, since offsets are recorded between
 *  writes rather than on line boundaries. Partial lines at either edge are
 *  dropped — a partial JSON array is not parseable and the loss is bounded by
 *  one write chunk. */
export async function readSingleCastRange(castPath: string, off: number, len: number): Promise<CastSlice | null> {
  if (!Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) return null
  if (len > MAX_CAST_BYTES) return null
  let stat: fs.Stats
  try { stat = fs.statSync(castPath) } catch { return null }
  if (off >= stat.size) return null
  const end = Math.min(off + len, stat.size) - 1

  const chunks: Buffer[] = []
  try {
    const stream = fs.createReadStream(castPath, { start: off, end })
    for await (const c of stream) chunks.push(c as Buffer)
  } catch { return null }

  const events: Array<[number, 'o', string]> = []
  let bytes = 0
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line) continue
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }   // partial edge line
    if (!Array.isArray(ev) || ev.length < 3) continue
    if (ev[1] !== 'o' || typeof ev[0] !== 'number' || typeof ev[2] !== 'string') continue
    events.push([ev[0] as number, 'o', ev[2] as string])
    bytes += Buffer.byteLength(ev[2] as string)
  }

  const joined = events.map((e) => e[2]).join('')
  return { events, text: stripAnsi(joined), bytes, truncated: off + len > stat.size, castStartMs: 0 }
}

/** The first part is the stable logical recording reference. Byte offsets count
 * every part, including its header. Each file remains independently playable. */
export function castParts(castPath: string): string[] {
  if (/\.part\d{6,}\.cast$/.test(castPath)) return [castPath]
  const dir = path.dirname(castPath), base = path.basename(castPath, '.cast')
  const parts = fs.readdirSync(dir).filter(name => name.startsWith(base + '.part') && /^\d{6,}\.cast$/.test(name.slice(base.length + 5)))
    .sort((a, b) => Number(a.slice(base.length + 5, -5)) - Number(b.slice(base.length + 5, -5)))
  for (let i = 0; i < parts.length; i++) {
    if (Number(parts[i].slice(base.length + 5, -5)) !== i + 2) throw new Error('Missing cast segment')
  }
  const result = [castPath, ...parts.map(name => path.join(dir, name))]
  if (result.some(file => !fs.lstatSync(file).isFile())) throw new Error('Invalid cast segment')
  return result
}

function combineSlices(slices: CastSlice[]): CastSlice | null {
  if (!slices.length) return null
  return { events: slices.flatMap(s => s.events), text: stripAnsi(slices.flatMap(s => s.events.map(event => event[2])).join('')),
    bytes: slices.reduce((n, s) => n + s.bytes, 0), truncated: slices.some(s => s.truncated), castStartMs: slices[0].castStartMs }
}

export async function readCastSlice(castPath: string, startMs: number, endMs: number, budget = MAX_CAST_BYTES): Promise<CastSlice | null> {
  try {
    const slices: CastSlice[] = []
    let readBytes = 0
    for (const part of castParts(castPath)) {
      const slice = await readSingleCastSlice(part, startMs, endMs, budget - readBytes)
      if (!slice) return null
      slices.push(slice); readBytes += slice.bytes
      if (slice.truncated) break
    }
    return combineSlices(slices)
  } catch { return null }
}

export async function readCastRange(castPath: string, off: number, len: number): Promise<CastSlice | null> {
  if (!Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) return null
  try {
    const slices: CastSlice[] = []
    let position = 0, remaining = Math.min(len, MAX_CAST_BYTES)
    for (const part of castParts(castPath)) {
      const size = fs.statSync(part).size
      if (position + size > off && remaining > 0) {
        const start = Math.max(0, off - position), count = Math.min(size - start, remaining)
        const slice = await readSingleCastRange(part, start, count)
        if (!slice) return null
        slices.push(slice); remaining -= count; off += count
      }
      position += size
      if (remaining <= 0) break
    }
    const result = combineSlices(slices)
    if (result) result.truncated ||= remaining > 0 || len > MAX_CAST_BYTES
    return result
  } catch { return null }
}
