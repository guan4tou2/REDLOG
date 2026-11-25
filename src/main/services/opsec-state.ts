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
// specific DNS probe (and, on Windows, the adapter descriptions — see
// refreshAdapterDescriptions). Poll every 30s; on any change, emit a single
// event with the delta so the timeline shows one row per shift, not four.
//
// A probe that fails is not a reading. "Could not ask" and "asked, and the
// answer was nothing" used to be the same empty list, so a PowerShell that
// took longer than its timeout was recorded as the resolvers disappearing and,
// 90 s later, coming back: 142 of the 146 opsec_state_changed rows in one real
// project were that (#885).

export interface OpsecState {
  vpnInterfaces: string[]  // sorted, deduped names of active VPN-shaped ifaces
  primaryMac: string | null
  hostname: string
  dnsServers: string[]     // sorted, deduped
}

const SYS_PATH = ['/sbin', '/usr/sbin', '/usr/bin', '/bin'].join(':')
/** `null` when the command failed or timed out. That is not the same answer as
 *  a command that ran and printed nothing, and the callers keep them apart. */
function run(cmd: string, timeout = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const env = process.platform === 'win32' ? process.env : { ...process.env, PATH: `${SYS_PATH}:${process.env.PATH ?? ''}` }
    exec(cmd, { timeout, windowsHide: true, env }, (err, stdout) => resolve(err ? null : stdout))
  })
}

// Windows names a tunnel after its config file, so the name says nothing about
// what it is: `wt0`, or a localised "Ethernet 3". What identifies the driver is
// the adapter's description — "WireGuard Tunnel", "Fortinet SSL VPN Virtual
// Ethernet Adapter" — and os.networkInterfaces() does not carry it (#880).
//
// Asking PowerShell for it takes 1.5–2.5 s, so it is asked when the monitor
// starts and again only when the set of interface names changes. A failure
// keeps the last answer and is not retried for ten minutes: without that, a
// machine where the query cannot work would pay for it on every poll.
const DESCRIBE_ADAPTERS = 'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ConvertTo-Json -Compress @(Get-NetAdapter | ForEach-Object { @{name=$_.Name; description=$_.InterfaceDescription} })"'
const DESCRIBE_RETRY_MS = 10 * 60_000
/** `descriptions` is null until the query has worked once; `names` is the set of
 *  interface names it was asked for; `retryAt` holds a failed query off. */
let adapterCache: { descriptions: Map<string, string> | null; names: string; retryAt: number } | null = null

function activeInterfaceNames(): string[] {
  const names: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (addrs?.some((a) => !a.internal && a.address)) names.push(name)
  }
  return names.sort()
}

async function refreshAdapterDescriptions(): Promise<void> {
  if (process.platform !== 'win32') return
  const key = activeInterfaceNames().join('\n')
  if (adapterCache?.descriptions && adapterCache.names === key) return
  if (adapterCache && Date.now() < adapterCache.retryAt) return
  const out = await run(DESCRIBE_ADAPTERS, 8000)
  let rows: unknown = null
  if (out !== null) { try { rows = JSON.parse(out) } catch { rows = null } }
  if (!Array.isArray(rows)) {
    adapterCache = { descriptions: adapterCache?.descriptions ?? null, names: adapterCache?.names ?? '', retryAt: Date.now() + DESCRIBE_RETRY_MS }
    return
  }
  const map = new Map<string, string>()
  for (const row of rows as Array<{ name?: unknown; description?: unknown }>) {
    if (typeof row?.name === 'string' && typeof row.description === 'string') map.set(row.name, row.description)
  }
  adapterCache = { descriptions: map, names: key, retryAt: 0 }
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
    const description = adapterCache?.descriptions?.get(name)
    if (vpnPatterns.some((re) => re.test(name) || (description !== undefined && re.test(description)))) vpn.push(name)
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

/** The resolvers in use, or `null` when they could not be read. */
async function detectDns(): Promise<string[] | null> {
  if (process.platform === 'win32') {
    // Get-DnsClientServerAddress returns one line per adapter+family; grab v4 servers.
    const out = await run('powershell -NoProfile -Command "(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses }) -join [char]10"')
    if (out === null) return null
    return dedupe(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  }
  if (process.platform === 'darwin') {
    // scutil is the authoritative view on macOS (may differ from /etc/resolv.conf).
    const out = await run('scutil --dns')
    if (out === null) return null
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
  if (out === null) return null
  const servers: string[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/)
    if (m) servers.push(m[1])
  }
  return dedupe(servers)
}

function dedupe(a: string[]): string[] { return Array.from(new Set(a)).sort() }

/** One poll. `dnsKnown` and `adaptersKnown` say whether that part is a reading
 *  or a blank left by a probe that failed; the state alone cannot tell. */
interface Probe { state: OpsecState; dnsKnown: boolean; adaptersKnown: boolean }

async function probe(): Promise<Probe> {
  await refreshAdapterDescriptions()
  const dns = await detectDns()
  return {
    state: {
      vpnInterfaces: detectVpnInterfaces(),
      primaryMac: detectPrimaryMac(),
      hostname: hostname(),
      dnsServers: dns ?? []
    },
    dnsKnown: dns !== null,
    adaptersKnown: process.platform !== 'win32' || Boolean(adapterCache?.descriptions)
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

// `dnsSeeded` / `vpnSeeded`: whether `state` holds a real first reading of that
// part. When the probe failed at the seed, the first reading that does arrive
// is adopted without an event: it is the first observation, not a change from
// the blank that stood in for it.
let last: { state: OpsecState; dnsSeeded: boolean; vpnSeeded: boolean } | null = null
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
    let p: Probe
    try { p = await probe() } catch { return }
    const now = p.state
    if (last === null) { last = { state: now, dnsSeeded: p.dnsKnown, vpnSeeded: p.adaptersKnown }; return } // seed silently
    const was = last.state
    if (!last.vpnSeeded && p.adaptersKnown) { was.vpnInterfaces = now.vpnInterfaces; last.vpnSeeded = true }
    if (!last.dnsSeeded && p.dnsKnown) { was.dnsServers = now.dnsServers; last.dnsSeeded = true }
    const delta: OpsecStateDelta = {}
    if (!arrEq(was.vpnInterfaces, now.vpnInterfaces)) delta.vpn = { from: was.vpnInterfaces, to: now.vpnInterfaces }
    if (was.primaryMac !== now.primaryMac) delta.primaryMac = { from: was.primaryMac, to: now.primaryMac }
    if (was.hostname !== now.hostname) delta.hostname = { from: was.hostname, to: now.hostname }

    // DNS: debounced — only emit after the new value holds for DNS_STABLE_TICKS polls.
    // A poll that could not read the resolvers says nothing about them: it
    // neither starts a change, nor counts towards one, nor cancels one.
    const dnsChanged = p.dnsKnown && !arrEq(was.dnsServers, now.dnsServers)
    if (!p.dnsKnown) {
      // nothing to compare
    } else if (dnsChanged && !dnsPending) {
      dnsPending = { candidate: now.dnsServers, from: was.dnsServers, ticks: 1 }
    } else if (dnsPending) {
      if (arrEq(dnsPending.candidate, now.dnsServers)) {
        dnsPending.ticks++
        if (dnsPending.ticks >= DNS_STABLE_TICKS) {
          delta.dns = { from: dnsPending.from, to: now.dnsServers }
          dnsPending = null
        }
      } else if (arrEq(was.dnsServers, now.dnsServers)) {
        // reverted to last confirmed state — cancel pending
        dnsPending = null
      } else {
        // changed to a third value — restart the window
        dnsPending = { candidate: now.dnsServers, from: dnsPending.from, ticks: 1 }
      }
    }

    // Update last for non-DNS fields immediately; DNS only when confirmed.
    if (!delta.dns) now.dnsServers = was.dnsServers
    last.state = now

    if (Object.keys(delta).length > 0) onChanged?.(delta, now)
  }
  tick() // seed immediately, then poll
  timer = setInterval(tick, 30_000)
}

export function stopOpsecMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
  last = null
  dnsPending = null
  adapterCache = null
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
