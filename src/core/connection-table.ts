// Connection-level network capture (docs/DESIGN-core-and-capture.md §2.1).
//
// mitmproxy only sees what is proxied. Scanning, SMB, LDAP, RDP, reverse
// shells and C2 beacons produce none of it, so a timeline can show
// `nmap -sV 10.10.11.24` and then nothing about what it did. This records the
// established connections the operator's box makes — who connected to which
// IP:port, over what protocol, for how long — with no payload and no root.
//
// This file is the pure half: turn one platform's socket-table dump into a
// list of connections, and diff two snapshots into opened/closed. The polling,
// the shelling-out and the event emission live in the monitor service, so the
// parsing — which is where the platform quirks and the edge cases are — can be
// tested without a network.
//
// ── The honest limitation ──────────────────────────────────────────────────
//
// Socket-table polling sees *established* connections. `nmap -sS` never
// completes a handshake, so a SYN scan is structurally invisible here — the
// command is recorded, the packets it produced are not. The UI must say so
// rather than imply coverage; this module cannot see what never opened, and
// pretending otherwise would be the confident-green failure the alerting model
// exists to prevent.

export type Proto = 'tcp' | 'udp' | 'tcp6' | 'udp6'

export interface Connection {
  proto: Proto
  localAddr: string
  localPort: number
  remoteAddr: string
  remotePort: number
  /** Owning pid when the platform's table gives it cheaply; undefined on macOS
   *  netstat, which needs lsof (and root for other users') to attribute. */
  pid?: number
}

/**
 * Identity of a connection across polls.
 *
 * Deliberately excludes pid: the same logical connection must diff as "still
 * open" even if the table attributes it differently between polls, and the
 * remote endpoint plus the local port is what makes it the same session. The
 * ephemeral local port is included because two beacons to the same C2 host are
 * two connections, and collapsing them would undercount the activity.
 */
export function connKey(c: Connection): string {
  return `${baseProto(c.proto)}|${c.localPort}|${c.remoteAddr}|${c.remotePort}`
}

function baseProto(p: Proto): 'tcp' | 'udp' {
  return p.startsWith('udp') ? 'udp' : 'tcp'
}

// ── Address helpers ─────────────────────────────────────────────────────────

/** Split a `host:port` where host may be bare IPv4, `[v6]`, or bracketless v6
 *  with the port after the last separator. Returns null when there is no port
 *  — a listening socket shown as `*` has nothing to record. */
function splitHostPort(s: string, sep: ':' | '.'): { host: string; port: number } | null {
  const raw = s.trim()
  if (!raw || raw === '*' || raw.endsWith(sep + '*')) return null
  // Bracketed IPv6: [::1]:443 or [fe80::1%eth0]:443
  const bracket = /^\[(.+)\]:(\d+)$/.exec(raw)
  if (bracket) return { host: stripZone(bracket[1]), port: Number(bracket[2]) }
  // Otherwise the port is after the LAST separator; everything before is host.
  const i = raw.lastIndexOf(sep)
  if (i <= 0) return null
  const host = raw.slice(0, i)
  const port = Number(raw.slice(i + 1))
  if (!Number.isFinite(port) || port <= 0) return null
  return { host: stripZone(host), port }
}

/** Drop a scope zone (`fe80::1%eth0` → `fe80::1`) — it is a local interface
 *  name, not part of the peer's identity, and varies by host. */
function stripZone(host: string): string {
  const z = host.indexOf('%')
  return z === -1 ? host : host.slice(0, z)
}

const LOOPBACK = /^(127\.|::1$|0\.0\.0\.0$|::$)/
const LINK_LOCAL = /^(169\.254\.|fe80:)/i

/**
 * A connection worth recording: established, to a real remote peer, and not
 * RedLog talking to itself.
 *
 * Loopback and link-local remotes are dropped — they are not engagement
 * traffic and would bury the reverse shell in a hundred rows of localhost. The
 * app's own API port is dropped explicitly: every shell hook POSTs to it, so
 * without this the timeline would fill with RedLog observing itself.
 */
export function isCapturable(c: Connection, selfPorts: ReadonlySet<number>): boolean {
  if (!c.remoteAddr || c.remotePort <= 0) return false
  if (LOOPBACK.test(c.remoteAddr) || LOOPBACK.test(c.localAddr)) return false
  if (LINK_LOCAL.test(c.remoteAddr)) return false
  if (selfPorts.has(c.remotePort)) return false
  return true
}

// ── Platform parsers ────────────────────────────────────────────────────────

/**
 * Linux `ss -tunpH state established`.
 *
 * Columns: netid, recv-q, send-q, local, peer, [process]. `-H` drops the
 * header, `state established` filters to what we can see. The process column,
 * when `-p` is honoured (root not required for own sockets), looks like
 * `users:(("nc",pid=1234,fd=3))`.
 */
export function parseSs(out: string): Connection[] {
  const conns: Connection[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const cols = t.split(/\s+/)
    if (cols.length < 5) continue
    const netid = cols[0].toLowerCase()
    if (netid !== 'tcp' && netid !== 'udp') continue
    const local = splitHostPort(cols[3], ':')
    const peer = splitHostPort(cols[4], ':')
    if (!local || !peer) continue
    const proto: Proto = peer.host.includes(':') ? (netid + '6') as Proto : netid as Proto
    const conn: Connection = {
      proto, localAddr: local.host, localPort: local.port,
      remoteAddr: peer.host, remotePort: peer.port
    }
    const pid = /pid=(\d+)/.exec(cols.slice(5).join(' '))
    if (pid) conn.pid = Number(pid[1])
    conns.push(conn)
  }
  return conns
}

/**
 * macOS `netstat -n -p tcp` (and `-p udp`).
 *
 * Established TCP lines: `tcp4  0  0  10.0.0.5.52341  10.10.11.24.445  ESTABLISHED`.
 * BSD netstat uses `addr.port` — a dot, not a colon — and IPv6 as `addr.port`
 * too (`::1.443`), so the port is always after the last dot. No pid without
 * lsof, and lsof needs root for other users', so pid stays undefined here; the
 * design accepts that (the "who" comes from command correlation, not the
 * socket table).
 */
export function parseNetstatBsd(out: string): Connection[] {
  const conns: Connection[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const cols = t.split(/\s+/)
    if (cols.length < 6) continue
    const proto = cols[0].toLowerCase()
    if (!/^(tcp|udp)[46]?$/.test(proto)) continue
    // UDP has no state column; TCP established rows end in ESTABLISHED.
    const isTcp = proto.startsWith('tcp')
    if (isTcp && cols[cols.length - 1] !== 'ESTABLISHED') continue
    const local = splitHostPort(cols[3], '.')
    const peer = splitHostPort(cols[4], '.')
    if (!local || !peer) continue
    const v6 = proto.endsWith('6') || peer.host.includes(':')
    conns.push({
      proto: (isTcp ? (v6 ? 'tcp6' : 'tcp') : (v6 ? 'udp6' : 'udp')) as Proto,
      localAddr: local.host, localPort: local.port,
      remoteAddr: peer.host, remotePort: peer.port
    })
  }
  return conns
}

/**
 * Windows `netstat -no -p tcp` (and `-p udp`).
 *
 * `  TCP  10.0.0.5:52341  10.10.11.24:445  ESTABLISHED  1234`. `-o` appends the
 * owning pid, `-n` keeps it numeric. UDP rows have `*:*` for the remote and no
 * state, so they are dropped by the no-remote guard rather than special-cased.
 */
export function parseNetstatWin(out: string): Connection[] {
  const conns: Connection[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const cols = t.split(/\s+/)
    if (cols.length < 4) continue
    const proto = cols[0].toLowerCase()
    if (proto !== 'tcp' && proto !== 'udp') continue
    if (proto === 'tcp' && cols[3] !== 'ESTABLISHED') continue
    const local = splitHostPort(cols[1], ':')
    const peer = splitHostPort(cols[2], ':')
    if (!local || !peer) continue
    const v6 = peer.host.includes(':')
    const conn: Connection = {
      proto: (proto === 'tcp' ? (v6 ? 'tcp6' : 'tcp') : (v6 ? 'udp6' : 'udp')) as Proto,
      localAddr: local.host, localPort: local.port,
      remoteAddr: peer.host, remotePort: peer.port
    }
    // pid is the last column on TCP rows (after the state); on UDP it is cols[3].
    const pidCol = proto === 'tcp' ? cols[4] : cols[3]
    if (pidCol && /^\d+$/.test(pidCol)) conn.pid = Number(pidCol)
    conns.push(conn)
  }
  return conns
}

// ── Diff ────────────────────────────────────────────────────────────────────

export interface ConnDiff {
  opened: Connection[]
  closed: Connection[]
}

/**
 * What opened and what closed between two snapshots, keyed by `connKey`.
 *
 * Both directions matter: an opened connection is when the operator reached a
 * host; a closed one carries the duration, which is the whole point of a span
 * (§3) — a reverse shell open from 14:32 to 15:11 is a long line, and that
 * shape is the information. A connection present in both is unchanged and
 * emits nothing, so a long-lived session is one open and one close, not a row
 * per poll.
 */
export function diffConns(
  prev: Map<string, Connection>,
  next: Map<string, Connection>
): ConnDiff {
  const opened: Connection[] = []
  const closed: Connection[] = []
  for (const [k, c] of next) if (!prev.has(k)) opened.push(c)
  for (const [k, c] of prev) if (!next.has(k)) closed.push(c)
  return { opened, closed }
}

/** Index a connection list by key, last-wins on the rare duplicate. */
export function indexConns(conns: Connection[]): Map<string, Connection> {
  const m = new Map<string, Connection>()
  for (const c of conns) m.set(connKey(c), c)
  return m
}
