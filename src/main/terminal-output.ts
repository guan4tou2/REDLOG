// PTY output on its way to the renderer: batched, and flow-controlled.
//
// It used to be one IPC message per node-pty data event, with nothing coming
// back. A flood (`yes`, `cat` of a large file, `find /`) is thousands of data
// events a second, so the renderer's queue of `terminal:data` messages, and
// xterm's own write buffer behind it, grew for as long as the shell could
// produce faster than xterm could parse — and xterm discards writes once 50 MB
// are pending.
//
// Batching: output is held for `delayMs` (or until `maxChars` are held) and
// sent as one message. Flow control (xterm's documented pattern, the one VS
// Code uses): every sent character is unacknowledged until the renderer's
// `term.write` callback reports it parsed; above `highWater` the pty is paused,
// below `lowWater` it is resumed. A paused pty stops reading, so the shell
// blocks on its own writes — nothing is dropped, and main never holds more
// than one batch.
//
// A renderer that stops acknowledging (a reload, a crash, a frozen page) must
// not freeze the shell: after `stallMs` paused with no acknowledgement the pty
// is resumed and stays unpaused until acknowledgements come back.
//
// Only what is sent to the renderer goes through here. The cast recording is
// written from the data event itself, chunk by chunk, with its own timestamp.

export interface OutputTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

const realTimers: OutputTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

export interface OutputPumpOptions {
  send: (data: string) => void
  pause: () => void
  resume: () => void
  delayMs?: number
  maxChars?: number
  highWater?: number
  lowWater?: number
  stallMs?: number
  timers?: OutputTimers
}

/** Characters between renderer acknowledgements (TerminalView). */
export const ACK_EVERY_CHARS = 5_000

export class TerminalOutputPump {
  private queued: string[] = []
  private queuedChars = 0
  private timer: unknown = null
  private stallTimer: unknown = null
  private lastAck: number
  private bypass = false
  unacked = 0
  paused = false
  private readonly o: Required<Omit<OutputPumpOptions, 'timers'>> & { timers: OutputTimers }

  constructor(opts: OutputPumpOptions) {
    this.o = {
      delayMs: 5, maxChars: 64 * 1024, highWater: 100_000, lowWater: 5_000, stallMs: 2_000, timers: realTimers,
      ...opts
    }
    this.lastAck = this.o.timers.now()
  }

  /** Characters held for the next send. */
  get pending(): number { return this.queuedChars }

  push(data: string): void {
    if (!data) return
    this.queued.push(data)
    this.queuedChars += data.length
    if (this.queuedChars >= this.o.maxChars) { this.flush(); return }
    if (this.timer === null) this.timer = this.o.timers.set(() => { this.timer = null; this.flush() }, this.o.delayMs)
  }

  /** Send what is held now (the delay elapsed, the cap was hit, or the shell exited). */
  flush(): void {
    if (this.timer !== null) { this.o.timers.clear(this.timer); this.timer = null }
    if (this.queuedChars === 0) return
    const data = this.queued.length === 1 ? this.queued[0] : this.queued.join('')
    this.queued = []
    this.queuedChars = 0
    this.o.send(data)
    this.unacked += data.length
    if (!this.paused && !this.bypass && this.unacked > this.o.highWater) {
      this.paused = true
      this.o.pause()
      this.armStall()
    }
  }

  /** The renderer has parsed `chars` more characters. */
  ack(chars: number): void {
    if (!Number.isFinite(chars) || chars <= 0) return
    this.lastAck = this.o.timers.now()
    this.bypass = false
    this.unacked = Math.max(0, this.unacked - chars)
    if (this.paused && this.unacked < this.o.lowWater) this.release()
  }

  /** A new renderer took the pane over (it replays the session's buffer):
   *  nothing sent before it counts, and nothing held is sent twice. */
  reattach(): void {
    if (this.timer !== null) { this.o.timers.clear(this.timer); this.timer = null }
    this.queued = []
    this.queuedChars = 0
    this.unacked = 0
    this.bypass = false
    this.lastAck = this.o.timers.now()
    if (this.paused) this.release()
  }

  dispose(): void {
    if (this.timer !== null) this.o.timers.clear(this.timer)
    if (this.stallTimer !== null) this.o.timers.clear(this.stallTimer)
    this.timer = null
    this.stallTimer = null
  }

  private release(): void {
    this.paused = false
    if (this.stallTimer !== null) { this.o.timers.clear(this.stallTimer); this.stallTimer = null }
    this.o.resume()
  }

  private armStall(): void {
    if (this.stallTimer !== null) return
    this.stallTimer = this.o.timers.set(() => {
      this.stallTimer = null
      if (!this.paused) return
      if (this.o.timers.now() - this.lastAck >= this.o.stallMs) {
        // Nobody is acknowledging: let the shell run, unpaced, until someone does.
        this.bypass = true
        this.release()
      } else {
        this.armStall()
      }
    }, this.o.stallMs)
  }
}
