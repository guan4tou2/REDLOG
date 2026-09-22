import { EventEmitter } from 'events'
import type { RedLogEvent } from './db/events'

/** Where a recording pause/resume came from. `ui` is the operator at the
 *  keyboard (button, tray, ⌘.); `api` is redlog-cli or another local REST
 *  client; `mcp` is an AI agent calling the redlog_recording tool. */
export type RecordingToggleSource = 'ui' | 'api' | 'mcp' | 'unknown'
export type RecordingMode = 'recording' | 'paused' | 'reporting'

class RedLogEventBus extends EventEmitter {
  private _paused = false
  private _pauseReason: Exclude<RecordingMode, 'recording'> | null = null

  get paused(): boolean { return this._paused }
  get mode(): RecordingMode { return this._paused ? (this._pauseReason ?? 'paused') : 'recording' }

  // v0.9.5: `source` rides along so the recording_paused / recording_resumed
  // rows say who flipped it. Pause now genuinely stops recording, which means
  // an agent holding a token can call redlog_recording and go dark — the two
  // bracketing system events are the only trace left, so they had better name
  // the origin. Combined with the operator_id resolved from the token, a
  // reviewer can tell "the operator paused" from "the agent paused itself".
  pause(source: RecordingToggleSource = 'unknown', reason: Exclude<RecordingMode, 'recording'> = 'paused'): void {
    const previous = this.mode
    if (previous === reason) return
    this._paused = true
    this._pauseReason = reason
    this.emit('recording', false, source, this.mode, previous)
  }

  resume(source: RecordingToggleSource = 'unknown'): void {
    const previous = this.mode
    if (previous === 'recording') return
    this._paused = false
    this._pauseReason = null
    this.emit('recording', true, source, this.mode, previous)
  }

  // v0.12.2: fanout is deferred via queueMicrotask so the caller (insertEvent
  // + everywhere that publishes after a DB write) returns before listeners
  // run. Every subscriber today either coalesces (renderer IPC batch,
  // AlertBus surfaces) or is already async — the sync
  // fanout was a latent stacking hazard as more subscribers land. Ordering
  // between two publish() calls is preserved (microtasks drain FIFO on the
  // same tick), so a command_start followed by command_end still reaches
  // subscribers in that order. Pause check stays synchronous — a listener
  // rejoining mid-microtask would otherwise miss the "paused" gate.
  publish(event: RedLogEvent, opts?: { bypassPause?: boolean }): void {
    if (this._paused && !opts?.bypassPause) return
    queueMicrotask(() => {
      this.emit('event', event)
      this.emit(`event:${event.agentType}`, event)
    })
  }
}

export const eventBus = new RedLogEventBus()
