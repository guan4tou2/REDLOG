import type { RedLogEvent } from '../db/events'

interface ShipperConfig {
  backend: string
  elasticsearch: {
    url: string
    index: string
    apiKey: string
  } | null
}

export class ShipperAgent {
  private config: ShipperConfig = { backend: 'elasticsearch', elasticsearch: null }
  private queue: RedLogEvent[] = []
  private interval: ReturnType<typeof setInterval> | null = null
  private shipping = false

  configure(config: ShipperConfig): void {
    this.config = config
  }

  start(): void {
    this.interval = setInterval(() => this.flush(), 5000)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    this.flush()
  }

  enqueue(event: RedLogEvent): void {
    this.queue.push(event)
    if (this.queue.length >= 100) this.flush()
  }

  getQueueSize(): number {
    return this.queue.length
  }

  private async flush(): Promise<void> {
    if (this.shipping || this.queue.length === 0) return
    if (!this.config.elasticsearch) return

    this.shipping = true
    const batch = this.queue.splice(0, 100)

    try {
      await this.shipToElasticsearch(batch)
    } catch {
      this.queue.unshift(...batch)
    }

    this.shipping = false
  }

  private async shipToElasticsearch(events: RedLogEvent[]): Promise<void> {
    const es = this.config.elasticsearch!
    const lines: string[] = []

    for (const event of events) {
      lines.push(JSON.stringify({ index: { _index: es.index, _id: event.id } }))
      lines.push(JSON.stringify({
        '@timestamp': new Date(event.timestamp).toISOString(),
        engagement_id: event.engagementId,
        session_id: event.sessionId,
        operator_id: event.operatorId,
        agent_type: event.agentType,
        hostname: event.hostname,
        source_ip: event.sourceIP,
        target_id: event.targetId,
        data: event.data,
        hash: event.hash
      }))
    }

    const body = lines.join('\n') + '\n'

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-ndjson'
    }
    if (es.apiKey) {
      headers['Authorization'] = `ApiKey ${es.apiKey}`
    }

    const res = await fetch(`${es.url}/_bulk`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!res.ok) {
      throw new Error(`ES bulk failed: ${res.status}`)
    }
  }
}
