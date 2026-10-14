import fs from 'fs'
import crypto from 'crypto'

export interface ClosedTerminalRecording {
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
  private result: ClosedTerminalRecording | null = null
  private failure: string | undefined
  bytes = 0
  truncated = false

  constructor(readonly path: string, header: Record<string, unknown>, private readonly maxBytes: number) {
    this.fd = fs.openSync(path, 'wx', 0o600)
    try { this.write(JSON.stringify(header) + '\n') }
    catch (error) { this.fail(error); this.close(); throw error }
  }

  get open(): boolean { return this.fd !== null }

  append(frame: [number, 'o' | 'r', string]): boolean {
    if (!this.open) return false
    const line = JSON.stringify(frame) + '\n'
    try {
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        this.truncated = true
        this.write(JSON.stringify([frame[0], 'o', `\r\n[redlog: cast truncated at ${this.maxBytes} bytes]\r\n`]) + '\n')
        this.close()
        return false
      }
      this.write(line)
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
      try { fs.closeSync(this.fd) } catch (error) { this.fail(error) }
      this.fd = null
    }
    this.result = {
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
      this.bytes += written
      offset += written
    }
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error)
  }
}
