import fs from 'fs'
import crypto from 'crypto'
import path from 'path'

export interface TerminalRecordingSegment {
  path: string
  bytes: number
  sha256: string
}

export interface ClosedTerminalRecording {
  segments: TerminalRecordingSegment[]
  bytes: number
  sha256: string | null
  truncated: boolean
  error?: string
}

/** How long frames may wait in memory before they are written, and how much
 *  may wait. A frame used to be one `writeSync` on the main thread per PTY data
 *  event; a flood is thousands a second. */
export const CAST_FLUSH_MS = 50
export const CAST_FLUSH_BYTES = 64 * 1024

/** Owns the descriptor and hashes only committed bytes. Project close can
 * finish a recording before SQLite closes, without racing queued stream writes
 * or re-reading an accumulated cast on the main thread.
 *
 * Frames are held and written together (CAST_FLUSH_MS / CAST_FLUSH_BYTES), on
 * a part change, on `flush()` and on `close()`. The file is byte-for-byte what
 * one write per frame produced: the same lines, in the same order, split into
 * parts at the same places, hashed as written (test/terminal-output.test.ts).
 * `bytes` is the logical position, held frames included, because command byte
 * ranges are taken from it; `flush()` before reading a range from disk. A write
 * that fails while frames are held is reported through `onError`. */
export class TerminalRecording {
  private fd: number | null
  private hash = crypto.createHash('sha256')
  private partHash = crypto.createHash('sha256')
  private partBytes = 0
  private partPath: string
  private readonly headerLine: string
  private readonly segments: TerminalRecordingSegment[] = []
  private result: ClosedTerminalRecording | null = null
  private failure: string | undefined
  private held: Buffer[] = []
  private heldBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  bytes = 0
  truncated = false

  constructor(readonly path: string, header: Record<string, unknown>, private readonly maxBytes: number,
    private readonly onError?: (error: string) => void) {
    this.headerLine = JSON.stringify(header) + '\n'
    if (maxBytes < Buffer.byteLength(this.headerLine) + 32) throw new Error('Cast segment budget is smaller than its header and a frame')
    this.partPath = path
    this.fd = fs.openSync(path, 'wx', 0o600)
    // The header goes to disk at once: a recording that cannot write fails here.
    try { this.write(this.headerLine); this.flush() }
    catch (error) { this.fail(error); this.close(); throw error }
  }

  /** Write held frames now. Throws what the write threw. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.heldBytes === 0 || this.fd === null) return
    const buffer = this.held.length === 1 ? this.held[0] : Buffer.concat(this.held, this.heldBytes)
    this.held = []
    this.heldBytes = 0
    let offset = 0
    try {
      while (offset < buffer.length) {
        const written = fs.writeSync(this.fd, buffer, offset, buffer.length - offset)
        if (written <= 0) throw new Error('Recording write made no progress')
        this.hash.update(buffer.subarray(offset, offset + written))
        this.partHash.update(buffer.subarray(offset, offset + written))
        offset += written
      }
    } catch (error) {
      // Count only what reached the disk, as a write per frame did.
      this.partBytes -= buffer.length - offset
      this.bytes -= buffer.length - offset
      throw error
    }
  }

  get open(): boolean { return this.fd !== null }

  append(frame: [number, 'o' | 'r', string]): boolean {
    if (!this.open) return false
    try {
      // Only split an oversized frame; normal PTY writes remain one frame.
      let text = frame[2]
      do {
        let line = JSON.stringify([frame[0], frame[1], text]) + '\n'
        const capacity = this.maxBytes - Buffer.byteLength(this.headerLine)
        let take = text.length
        if (Buffer.byteLength(line) > capacity) {
          let low = 0, high = text.length
          while (low < high) {
            const mid = Math.ceil((low + high) / 2)
            if (Buffer.byteLength(JSON.stringify([frame[0], frame[1], text.slice(0, mid)]) + '\n') <= capacity) low = mid
            else high = mid - 1
          }
          take = low
          // Never split a surrogate pair between independently playable parts.
          if (take > 0 && /[\uD800-\uDBFF]/.test(text[take - 1])) take--
          if (take === 0) throw new Error('Cast segment budget cannot hold a frame')
          line = JSON.stringify([frame[0], frame[1], text.slice(0, take)]) + '\n'
        }
        if (this.partBytes + Buffer.byteLength(line) > this.maxBytes) this.nextPart()
        this.write(line)
        text = text.slice(take)
      } while (text.length > 0)
      return true
    } catch (error) {
      this.fail(error)
      this.close()
      return false
    }
  }

  close(): ClosedTerminalRecording {
    if (this.result) return this.result
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.fd !== null) {
      try { this.flush() } catch (error) { this.fail(error) }
      try { this.closePart() } catch (error) { this.fail(error) }
    }
    this.result = {
      segments: [...this.segments],
      bytes: this.bytes,
      sha256: this.failure ? null : this.hash.digest('hex'),
      truncated: this.truncated,
      ...(this.failure ? { error: this.failure } : {})
    }
    return this.result
  }

  private write(text: string): void {
    const buffer = Buffer.from(text)
    this.held.push(buffer)
    this.heldBytes += buffer.length
    this.partBytes += buffer.length
    this.bytes += buffer.length
    if (this.heldBytes >= CAST_FLUSH_BYTES) { this.flush(); return }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        try { this.flush() } catch (error) {
          this.fail(error)
          this.close()
          this.onError?.(this.failure ?? 'Recording write failed')
        }
      }, CAST_FLUSH_MS)
      this.flushTimer.unref?.()
    }
  }

  private closePart(): void {
    // Held frames belong to this part.
    this.flush()
    const fd = this.fd
    this.fd = null
    if (fd === null) return
    fs.closeSync(fd)
    this.segments.push({ path: this.partPath, bytes: this.partBytes, sha256: this.partHash.digest('hex') })
  }

  private nextPart(): void {
    this.closePart()
    const ext = path.extname(this.path)
    this.partPath = (ext ? this.path.slice(0, -ext.length) : this.path) + `.part${String(this.segments.length + 1).padStart(6, '0')}` + ext
    this.fd = fs.openSync(this.partPath, 'wx', 0o600)
    this.partHash = crypto.createHash('sha256')
    this.partBytes = 0
    this.write(this.headerLine)
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error)
  }
}
