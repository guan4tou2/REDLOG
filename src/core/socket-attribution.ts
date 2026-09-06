// Socket → pid → command attribution (docs/DESIGN-traffic-attribution.md §2.3,
// PRD B3).
//
// "Which command produced this traffic?" is answered here. Traffic events carry
// either a pid (connection-monitor reads it from the socket table on Linux /
// Windows) or a source address (mitmproxy sends the client's ip:port). A shell
// command_start carries a pid. Two bounded maps join them:
//
//   localPort → pid          (connection-monitor, when it observes a socket)
//   pid       → command_start eventId   (a shell command_start that landed)
//
// so a request event resolves command = pidCmd[portPid[port(source_addr)]], and
// a connection event resolves command = pidCmd[pid]. The result fills `_causes`,
// exactly like causes-resolver's flow_id / terminal linkage — so clicking a
// request jumps to the sqlmap that opened it, and a command expands to the
// traffic it produced.
//
// Best-effort by design: resolution returns [] when the join is not known
// (macOS gives no pid, the socket was gone before the HTTP event arrived, the
// command was not hooked). Attribution never blocks capture — an unattributed
// event still lands, just without a `_causes` edge.

const MAX_ENTRIES = 10_000

class BoundedMap<K, V> {
  private m = new Map<K, V>()
  set(key: K, value: V): void {
    if (this.m.has(key)) this.m.delete(key)
    this.m.set(key, value)
    if (this.m.size > MAX_ENTRIES) {
      const oldest = this.m.keys().next().value as K | undefined
      if (oldest !== undefined) this.m.delete(oldest)
    }
  }
  get(key: K): V | undefined { return this.m.get(key) }
  clear(): void { this.m.clear() }
}

// localPort → pid. Refreshed whenever the connection monitor sees a socket with
// a known owner; the newest writer wins (a port is reused over time).
const portPid = new BoundedMap<number, number>()
// pid → the eventId of the command_start that pid belongs to.
const pidCmd = new BoundedMap<number, string>()

/** connection-monitor: this local ephemeral port is owned by this pid. */
export function notePortPid(localPort: number | undefined, pid: number | undefined): void {
  if (typeof localPort === 'number' && localPort > 0 && typeof pid === 'number' && pid > 0) {
    portPid.set(localPort, pid)
  }
}

/** ingest: a shell command_start with this pid just landed as `eventId`. */
export function noteCommandPid(pid: number | undefined, eventId: string): void {
  if (typeof pid === 'number' && pid > 0 && eventId) pidCmd.set(pid, eventId)
}

/** The command eventId that owns this pid, or null. */
export function resolveByPid(pid: number | undefined): string | null {
  if (typeof pid !== 'number' || pid <= 0) return null
  return pidCmd.get(pid) ?? null
}

/** The command eventId that owns this local port (port → pid → command), or null. */
export function resolveByLocalPort(localPort: number | undefined): string | null {
  if (typeof localPort !== 'number' || localPort <= 0) return null
  const pid = portPid.get(localPort)
  return pid === undefined ? null : resolveByPid(pid)
}

/** Parse the local port out of a "host:port" source address (IPv4 or bracketed
 *  IPv6). Returns undefined when there is no parseable trailing port. */
export function portOfSourceAddr(addr: unknown): number | undefined {
  if (typeof addr !== 'string' || !addr) return undefined
  const i = addr.lastIndexOf(':')
  if (i < 0 || i === addr.length - 1) return undefined
  const n = Number(addr.slice(i + 1))
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined
}

/**
 * The command-attribution `_causes` for a traffic event, or []:
 *  - a connection event carries `pid` → resolveByPid
 *  - an HTTP/DNS event carries `source_addr` → port → resolveByLocalPort
 * Only traffic agent_types are considered; anything else returns [].
 */
export function socketCausesFor(agentType: string, data: Record<string, unknown>): string[] {
  if (agentType !== 'scanner' && agentType !== 'dns' && agentType !== 'http_navigation') return []
  const byPid = resolveByPid(data.pid as number | undefined)
  if (byPid) return [byPid]
  const byPort = resolveByLocalPort(
    (data.local_port as number | undefined) ?? portOfSourceAddr(data.source_addr)
  )
  return byPort ? [byPort] : []
}

/** Test helper. */
export function _resetSocketAttribution(): void {
  portPid.clear()
  pidCmd.clear()
}
