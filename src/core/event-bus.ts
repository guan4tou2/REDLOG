import { EventEmitter } from 'events'
import type { RedLogEvent } from './db/events'

/** Where a recording pause/resume came from. `ui` is the operator at the
 *  keyboard (button, tray, ⌘.); `api` is redlog-cli or another local REST
 *  client; `mcp` is an AI agent calling the redlog_recording tool. */
export type RecordingToggleSource = 'ui' | 'api' | 'mcp' | 'unknown'

class RedLogEventBus extends EventEmitter {
  private _paused = false

  get paused(): boolean { return this._paused }

  // v0.9.5: `source` rides along so the recording_paused / recording_resumed
  // rows say who flipped it. Pause now genuinely stops recording, which means
  // an agent holding a token can call redlog_recording and go dark — the two
  // bracketing system events are the only trace left, so they had better name
  // the origin. Combined with the operator_id resolved from the token, a
  // reviewer can tell "the operator paused" from "the agent paused itself".
  pause(source: RecordingToggleSource = 'unknown'): void {
    this._paused = true
    this.emit('recording', false, source)
  }

  resume(source: RecordingToggleSource = 'unknown'): void {
    this._paused = false
    this.emit('recording', true, source)
  }

  publish(event: RedLogEvent, opts?: { bypassPause?: boolean }): void {
    if (this._paused && !opts?.bypassPause) return
    this.emit('event', event)
    this.emit(`event:${event.agentType}`, event)
  }
}

export const eventBus = new RedLogEventBus()
