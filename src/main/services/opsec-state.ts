import { networkInterfaces, hostname } from 'os'
import { exec } from 'child_process'
import type { VpnAdapter } from '../../core/config'

// OPSEC state a red-teamer needs preserved in the audit log:
//   • VPN interfaces up/down       — proves the tunnel was actually up
//   • DNS resolver set             — proves DNS wasn't leaking outside the VPN
//   • Primary-iface MAC            — MAC randomization is an OPSEC control;
//                                    every change should be visible
//   • Hostname                     — same rationale
//
// Ringmast4r's 7-layer OPSEC stack treats each of these as a first-class event,
// distinct from public-IP flips (which RedLog already logs). We detect them via
// Node's os.networkInterfaces() (portable, no shell-out) plus one platform-
// specific DNS probe. Poll every 30s; on any change, emit a single event with
// the delta so the timeline shows one row per shift, not four.

export interface OpsecState {
  vpnInterfaces: string[]  // sorted, deduped names of active VPN-shaped ifaces
  primaryMac: string | null
  hostname: string
  dnsServers: string[]     // sorted, deduped
}

const SYS_PATH = ['/sbin', '/usr/sbin', '/usr/bin', '/bin'].join(':')
function run(cmd: string, timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    const env = process.platform === 'win32' ? process.env : { ...process.env, PATH: `${SYS_PATH}:${process.env.PATH ?? ''}` }
    exec(cmd, { timeout, windowsHide: true, env }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

let vpnPatterns: RegExp[] = []

export function setVpnAdapters(adapters: VpnAdapter[]): void {
  vpnPatterns = adapters
    .filter((a) => a.enabled)
    .map((a) => { try { return new RegExp(a.pattern, 'i') } catch { return null } })
    .filter((r): r is RegExp => r !== null)
}

function detectVpnInterfaces(): string[] {
  const ifaces = networkInterfaces()
  const vpn: string[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || addrs.length === 0) continue
    const hasReal = addrs.some((a) => !a.internal && a.address)
    if (!hasReal) continue
    if (vpnPatterns.some((re) => re.test(name))) vpn.push(name)
  }
  return vpn.sort()
}

// The MAC of the interface carrying the (single) IPv4 address we consider
// primary — chosen the same way IPMonitor picks the internal IP. This lets
// "primaryMac changed" catch MAC randomization events without listing every
// iface's MAC (which would flap on Wi-Fi disassoc).
function detectPrimaryMac(): string | null {
  const ifaces = networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && a.mac && a.mac !== '00:00:00:00:00:00') return a.mac
    }
  }
  return null
}

async function detectDns(): Promise<string[]> {
  if (process.platform === 'win32') {
    // Get-DnsClientServerAddress returns one line per adapter+family; grab v4 servers.
    const out = await run('powershell -NoProfile -Command "(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses }) -join [char]10"')
    return dedupe(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  }
  if (process.platform === 'darwin') {
    // scutil is the authoritative view on macOS (may differ from /etc/resolv.conf).
    const out = await run('scutil --dns')
    const servers: string[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*nameserver\[\d+\]\s*:\s*(\S+)/)
      if (m) servers.push(m[1])
    }
    return dedupe(servers)
  }
  // Linux + BSD: /etc/resolv.conf is the standard read (systemd-resolved's
  // stub is included since it points at 127.0.0.53 anyway).
  const out = await run('cat /etc/resolv.conf')
  const servers: string[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/)
    if (m) servers.push(m[1])
  }
  return dedupe(servers)
}

function dedupe(a: string[]): string[] { return Array.from(new Set(a)).sort() }

export async function readOpsecState(): Promise<OpsecState> {
  return {
    vpnInterfaces: detectVpnInterfaces(),
    primaryMac: detectPrimaryMac(),
    hostname: hostname(),
    dnsServers: await detectDns()
  }
}

// --- Poller ---

type OnStateChanged = (delta: OpsecStateDelta, current: OpsecState) => void
export interface OpsecStateDelta {
  vpn?: { from: string[]; to: string[] }
  primaryMac?: { from: string | null; to: string | null }
  hostname?: { from: string; to: string }
  dns?: { from: string[]; to: string[] }
}

let last: OpsecState | null = null
let timer: ReturnType<typeof setInterval> | null = null
let onChanged: OnStateChanged | null = null

// DNS resolvers oscillate on DHCP renew / VPN reconnect / split-tunnel changes,
// flooding the timeline with spurious opsec_state_changed events. We require DNS
// to stay at the new value for DNS_STABLE_TICKS consecutive polls before emitting.
// VPN / MAC / hostname changes fire immediately — they reflect real operator actions.
const DNS_STABLE_TICKS = 3 // 3 × 30s = 90s stability window
let dnsPending: { candidate: string[]; from: string[]; ticks: number } | null = null

export function configureOpsecMonitor(cb: OnStateChanged): void { onChanged = cb }

export function startOpsecMonitor(): void {
  if (timer) return
  const tick = async (): Promise<void> => {
    let now: OpsecState
    try { now = await readOpsecState() } catch { return }
    if (last === null) { last = now; return } // seed silently
    const delta: OpsecStateDelta = {}
    if (!arrEq(last.vpnInterfaces, now.vpnInterfaces)) delta.vpn = { from: last.vpnInterfaces, to: now.vpnInterfaces }
    if (last.primaryMac !== now.primaryMac) delta.primaryMac = { from: last.primaryMac, to: now.primaryMac }
    if (last.hostname !== now.hostname) delta.hostname = { from: last.hostname, to: now.hostname }

    // DNS: debounced — only emit after the new value holds for DNS_STABLE_TICKS polls.
    const dnsChanged = !arrEq(last.dnsServers, now.dnsServers)
    if (dnsChanged && !dnsPending) {
      dnsPending = { candidate: now.dnsServers, from: last.dnsServers, ticks: 1 }
    } else if (dnsPending) {
      if (arrEq(dnsPending.candidate, now.dnsServers)) {
        dnsPending.ticks++
        if (dnsPending.ticks >= DNS_STABLE_TICKS) {
          delta.dns = { from: dnsPending.from, to: now.dnsServers }
          dnsPending = null
        }
      } else if (arrEq(last.dnsServers, now.dnsServers)) {
        // reverted to last confirmed state — cancel pending
        dnsPending = null
      } else {
        // changed to a third value — restart the window
        dnsPending = { candidate: now.dnsServers, from: dnsPending.from, ticks: 1 }
      }
    }

    // Update last for non-DNS fields immediately; DNS only when confirmed.
    const confirmedDns = last.dnsServers
    last = now
    if (!delta.dns) last.dnsServers = confirmedDns

    if (Object.keys(delta).length > 0) onChanged?.(delta, last)
  }
  tick() // seed immediately, then poll
  timer = setInterval(tick, 30_000)
}

export function stopOpsecMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
  last = null
  dnsPending = null
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
