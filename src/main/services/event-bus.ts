import { EventEmitter } from 'events'
import type { RedLogEvent } from '../db/events'

class RedLogEventBus extends EventEmitter {
  publish(event: RedLogEvent): void {
    this.emit('event', event)
    this.emit(`event:${event.agentType}`, event)
  }
}

export const eventBus = new RedLogEventBus()
