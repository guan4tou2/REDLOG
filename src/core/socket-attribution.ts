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
// THE PID A SHELL HOOK SENDS IS THE SHELL'S, NOT THE COMMAND'S.
//
// `hooks/shell-common.sh` sends `$$`. A `preexec` hook fires before the fork,
// so the shell cannot know the child's pid — but the socket is opened by the
// child (`dirb`, `sqlmap`), and that is the pid the socket table reports. So
// `pidCmd` was keyed on the shell and `portPid` on its child, and the two maps
// could never meet. Every HTTP flow resolved to nothing, silently, while the
// whole path looked wired.
//
// `process-monitor.ts` records as much: `findCauseSession()` was deleted
// because it always returned undefined.
//
// The missing link is ancestry, and only the OS has it. `noteProcessParent`
// takes pid → ppid from whatever is watching processes, and `resolveByPid`
// walks up from the socket's owner until it reaches a pid that ran a command.
// A `dirb` whose parent is the hooked zsh resolves to the `dirb` command_start
// — which is the edge the design asked for all along.
//
// Best-effort by design: resolution returns [] when the join is not known
// (no process watcher, macOS gives no socket owner, the socket was gone before
// the HTTP event arrived, the command was not hooked). Attribution never
// blocks capture — an unattributed event still lands, just without a `_causes`
// edge. It must never GUESS: a wrong edge is a false claim about who did what,
// and this record is handed to a client.

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
// pid → ppid, from whatever is watching the process table. The bridge between
// the pid a socket reports (the child) and the pid a shell hook reports (the
// shell that forked it).
const parentOf = new BoundedMap<number, number>()

/** How far up the process tree to look for a command. Deep enough for the
 *  real shapes — `zsh → sudo → tool`, `zsh → proxychains → tool`, a wrapper
 *  script around a wrapper — and shallow enough that a pid whose ancestry is
 *  unknown cannot walk to an unrelated ancient process and cite it. */
export const MAX_ANCESTRY_DEPTH = 8

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

/** process watcher: this pid was forked by this one. */
export function noteProcessParent(pid: number | undefined, ppid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return
  if (typeof ppid !== 'number' || ppid <= 0 || ppid === pid) return
  parentOf.set(pid, ppid)
}

/**
 * The command eventId that owns this pid, or null.
 *
 * Walks up through `parentOf` when the pid itself ran no command, because the
 * pid on a socket is the tool and the pid on a command_start is the shell that
 * forked it. Bounded by MAX_ANCESTRY_DEPTH, and by a seen-set: a process table
 * read mid-reparent can contain a cycle, and an attribution walk must not be
 * the thing that hangs capture.
 */
export function resolveByPid(pid: number | undefined): string | null {
  if (typeof pid !== 'number' || pid <= 0) return null
  const seen = new Set<number>()
  let at: number | undefined = pid
  for (let depth = 0; at !== undefined && depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (seen.has(at)) return null
    seen.add(at)
    const cmd = pidCmd.get(at)
    if (cmd) return cmd
    at = parentOf.get(at)
  }
  return null
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
  parentOf.clear()
}
