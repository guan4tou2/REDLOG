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

/** Owns the descriptor and hashes only committed bytes. Project close can
 * finish a recording before SQLite closes, without racing queued stream writes
 * or re-reading an accumulated cast on the main thread. */
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
  bytes = 0
  truncated = false

  constructor(readonly path: string, header: Record<string, unknown>, private readonly maxBytes: number) {
    this.headerLine = JSON.stringify(header) + '\n'
    if (maxBytes < Buffer.byteLength(this.headerLine) + 32) throw new Error('Cast segment budget is smaller than its header and a frame')
    this.partPath = path
    this.fd = fs.openSync(path, 'wx', 0o600)
    try { this.write(this.headerLine) }
    catch (error) { this.fail(error); this.close(); throw error }
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
    if (this.fd !== null) {
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
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(this.fd!, buffer, offset, buffer.length - offset)
      if (written <= 0) throw new Error('Recording write made no progress')
      this.hash.update(buffer.subarray(offset, offset + written))
      this.partHash.update(buffer.subarray(offset, offset + written))
      this.partBytes += written
      this.bytes += written
      offset += written
    }
  }

  private closePart(): void {
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
