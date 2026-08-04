// v0.6.89 P0-A: `_causes` upstream-event lookup for events that arrive via
// /api/events (or any other post-hoc insertion path). Each event pair follows
// a "start emits linker; end refers to linker" pattern:
//
//   http_request_start (flow_id) → http_response / http_error / http_request_dropped
//   shell.command_start (terminal_id + pid, or command text if pid is unset)
//     → shell.command_end
//
// When a "start" event is inserted, `noteStartEvent(agentType, data, eventId)`
// caches the linker → event id. When an "end" event is inserted,
// `resolveIncomingCauses(agentType, data)` reads the cache and returns the
// upstream event id(s) to stamp into `data._causes`.
//
// The cache is bounded — evict the oldest entry when the map hits capacity so
// a long-running instance doesn't leak. TTL is not tracked; the mitmproxy
// addon caps flows at 5 min and shell command lifetime is bounded by the
// operator's terminal session, so eviction by size is enough.

const MAX_ENTRIES = 10_000

class BoundedMap<V> {
  private m = new Map<string, V>()
  set(key: string, value: V): void {
    if (this.m.has(key)) this.m.delete(key)
    this.m.set(key, value)
    if (this.m.size > MAX_ENTRIES) {
      const oldest = this.m.keys().next().value as string | undefined
      if (oldest) this.m.delete(oldest)
    }
  }
  get(key: string): V | undefined { return this.m.get(key) }
  delete(key: string): void { this.m.delete(key) }
  size(): number { return this.m.size }
  clear(): void { this.m.clear() }
}

// flow_id → http_request_start event id
const httpFlowMap = new BoundedMap<string>()

// `${terminalId}|${pid}|${command}` → shell.command_start event id
const shellStartMap = new BoundedMap<string>()

function shellKey(data: Record<string, unknown>): string | null {
  const tid = data.terminal_id != null ? String(data.terminal_id) : ''
  const pid = data.pid != null ? String(data.pid) : ''
  const cmd = data.command != null ? String(data.command) : ''
  if (!cmd) return null
  // (tid,pid) uniquely identifies a live command within a terminal. If both
  // are absent (external agents), fall back to command text alone — coarser
  // but still useful (agents rarely run the same command twice in 2s).
  return `${tid}|${pid}|${cmd}`
}

/**
 * Called AFTER an event lands in the DB. If it's a "start" event (that later
 * "end" events will want to cite as their cause), stash its id in the cache.
 */
export function noteStartEvent(agentType: string, data: Record<string, unknown>, eventId: string): void {
  if (agentType === 'scanner' && data.subtype === 'http_request_start' && typeof data.flow_id === 'string') {
    httpFlowMap.set(data.flow_id, eventId)
    return
  }
  if (agentType === 'shell' && data.subtype === 'command_start') {
    const key = shellKey(data)
    if (key) shellStartMap.set(key, eventId)
    return
  }
}

/**
 * Called BEFORE insertEvent for an "end" event. Returns the upstream event
 * id(s) to add to `data._causes`. Empty array when no upstream is known
 * (e.g. we started recording mid-flow, or the start event was evicted).
 */
export function resolveIncomingCauses(agentType: string, data: Record<string, unknown>): string[] {
  if (agentType === 'scanner') {
    const sub = data.subtype
    if ((sub === 'http_response' || sub === 'http_error' || sub === 'http_request_dropped') && typeof data.flow_id === 'string') {
      const id = httpFlowMap.get(data.flow_id)
      if (id) {
        // Only clear on response — dropped/error might reference a flow that
        // still receives a real response later (rare but possible via retry).
        if (sub === 'http_response') httpFlowMap.delete(data.flow_id)
        return [id]
      }
    }
    return []
  }
  if (agentType === 'shell' && data.subtype === 'command_end') {
    const key = shellKey(data)
    if (key) {
      const id = shellStartMap.get(key)
      if (id) {
        shellStartMap.delete(key)
        return [id]
      }
    }
    return []
  }
  return []
}

/** Test helper. */
export function _resetCausesResolver(): void {
  httpFlowMap.clear()
  shellStartMap.clear()
}
