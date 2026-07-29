import { EventEmitter } from 'events'
import type { RedLogEvent } from './db/events'

class RedLogEventBus extends EventEmitter {
  private _paused = false

  get paused(): boolean { return this._paused }

  pause(): void {
    this._paused = true
    this.emit('recording', false)
  }

  resume(): void {
    this._paused = false
    this.emit('recording', true)
  }

  publish(event: RedLogEvent, opts?: { bypassPause?: boolean }): void {
    if (this._paused && !opts?.bypassPause) return
    this.emit('event', event)
    this.emit(`event:${event.agentType}`, event)
  }
}

export const eventBus = new RedLogEventBus()
