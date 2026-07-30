// Pivot / tunnel detection for internal-network (lateral movement) work.
//
// Internal pentests reach target subnets THROUGH intermediate nodes — a
// ligolo-ng agent, a chisel/ssh tunnel, a sshuttle route, a proxychains hop.
// The audit-relevant facts are: which tool, via which pivot node, exposing
// which route/SOCKS port. This classifier turns a shell command into that
// structured record so RedLog can emit a first-class `pivot` event, giving the
// timeline an explicit picture of the pivot topology instead of a bare command.

export interface PivotInfo {
  tool: 'ligolo-ng' | 'chisel' | 'proxychains' | 'ssh' | 'sshuttle' | 'socat'
  /** what happened: tunnel_start | socks_up | port_forward | route_add | agent_connect | proxied */
  subtype: string
  /** the intermediate/jump node the pivot goes through, if named on the command */
  via?: string
  /** CIDR reachable through the pivot, if declared (e.g. sshuttle) */
  route?: string
  /** local SOCKS port opened, if any */
  socksPort?: number
  /** raw forward spec (e.g. 8080:10.0.0.5:80) */
  forward?: string
  /** MITRE ATT&CK technique: T1090 Proxy or T1572 Protocol Tunneling */
  mitreTtp: string
}

const IP_OR_HOST = /([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+|\d{1,3}(?:\.\d{1,3}){3})/
const CIDR = /\b(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/
const T_PROXY = 'T1090'
const T_TUNNEL = 'T1572'

/** Classify a command as a pivot/tunnel setup, or null if it isn't one. */
export function detectPivot(command: string): PivotInfo | null {
  const cmd = command.trim()
  const first = cmd.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? ''

  // ligolo-ng: `agent -connect 10.0.0.5:11601` / `ligolo-ng ...` / `proxy -selfcert`
  // (binaries are commonly `./agent` / `./proxy`, so key off the basename `first`)
  const isLigolo = /ligolo/.test(first) ||
    ((first === 'agent' || first === 'proxy') && /-connect|-selfcert|-relay/.test(cmd))
  if (isLigolo) {
    const connect = cmd.match(/-connect\s+([^\s]+)/)
    if (connect) return { tool: 'ligolo-ng', subtype: 'agent_connect', via: connect[1].replace(/:\d+$/, ''), mitreTtp: T_TUNNEL }
    if (/-selfcert/.test(cmd) || first === 'proxy') return { tool: 'ligolo-ng', subtype: 'tunnel_start', mitreTtp: T_TUNNEL }
  }

  // chisel: `chisel client <server> R:socks` / `chisel client host:port R:8080:10.0.0.5:80`
  if (first === 'chisel') {
    const server = cmd.match(/client\s+(?:https?:\/\/)?([^\s]+)/)
    const rspec = cmd.match(/\bR:([^\s]+)/)
    if (rspec) return { tool: 'chisel', subtype: /socks/i.test(rspec[1]) ? 'socks_up' : 'port_forward', via: server?.[1]?.replace(/:\d+$/, ''), forward: rspec[1], mitreTtp: T_TUNNEL }
    if (server) return { tool: 'chisel', subtype: 'tunnel_start', via: server[1].replace(/:\d+$/, ''), mitreTtp: T_TUNNEL }
  }

  // sshuttle: `sshuttle -r user@jump 10.10.0.0/16 ...`
  if (first === 'sshuttle') {
    const jump = cmd.match(/-r\s+(?:[^@\s]+@)?([^\s]+)/)
    const route = cmd.match(CIDR)
    return { tool: 'sshuttle', subtype: 'route_add', via: jump?.[1], route: route?.[1], mitreTtp: T_PROXY }
  }

  // proxychains / proxychains4: wraps another command whose real target is remote
  if (first === 'proxychains' || first === 'proxychains4') {
    const rest = cmd.replace(/^proxychains4?\s+(-q\s+|-f\s+\S+\s+)*/, '')
    const target = rest.match(IP_OR_HOST)
    return { tool: 'proxychains', subtype: 'proxied', via: target?.[1], mitreTtp: T_PROXY }
  }

  // ssh dynamic/local/remote forwards: -D (SOCKS), -L / -R (port forward)
  if (first === 'ssh' || first === 'autossh') {
    const host = cmd.match(/(?:[^@\s]+@)([^\s]+)/)?.[1] ?? cmd.trim().split(/\s+/).pop()
    const d = cmd.match(/-D\s*(\d+)/)
    if (d) return { tool: 'ssh', subtype: 'socks_up', via: host, socksPort: Number(d[1]), mitreTtp: T_PROXY }
    const l = cmd.match(/-[LR]\s*([^\s]+)/)
    if (l) return { tool: 'ssh', subtype: 'port_forward', via: host, forward: l[1], mitreTtp: T_TUNNEL }
    // Plain interactive ssh (no -D/-L/-R). We record it because subsequent
    // commands in that pty are the remote shell — the operator asked to
    // surface this in the pivot lane so timeline reflects "attention has
    // moved to a remote host" until the ssh session ends.
    // Filter out flag-only invocations (e.g. `ssh -V`, `ssh -Q cipher`) by
    // requiring a hostname candidate that isn't a flag.
    if (host && !host.startsWith('-') && host.includes('.')) {
      return { tool: 'ssh', subtype: 'interactive', via: host, mitreTtp: T_TUNNEL }
    }
    // Bare `ssh user@short-host` (no dot) still counts.
    if (host && !host.startsWith('-') && /@/.test(cmd)) {
      return { tool: 'ssh', subtype: 'interactive', via: host, mitreTtp: T_TUNNEL }
    }
  }

  // socat relay: `socat TCP-LISTEN:9000,fork TCP:10.0.0.5:80`
  if (first === 'socat' && /LISTEN/i.test(cmd) && /TCP:|TCP4:|TCP6:/i.test(cmd)) {
    const to = cmd.match(/TCP[46]?:([^\s,]+)/i)
    return { tool: 'socat', subtype: 'port_forward', via: to?.[1]?.replace(/:\d+$/, ''), forward: to?.[1], mitreTtp: T_TUNNEL }
  }

  return null
}
