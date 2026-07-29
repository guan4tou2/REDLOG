import { exec } from 'child_process'

// The active network link: Wi-Fi SSID or wired. Read entirely from local system
// tools (no network egress), so it fits RedLog's quiet-by-default posture.
export interface NetworkLink {
  type: 'wifi' | 'wired' | 'unknown'
  /** SSID for Wi-Fi; empty for wired/unknown (the UI localises the wired label) */
  name: string
}

// A GUI-launched Electron app inherits a minimal PATH that usually omits /sbin
// and /usr/sbin — exactly where `route`, `networksetup`, `ipconfig`, and `ip`
// live. Without this every probe below would silently exec-fail and we'd always
// report 'unknown'. Prepend the standard system dirs so the tools resolve.
const SYS_PATH = ['/sbin', '/usr/sbin', '/usr/bin', '/bin'].join(':')

function run(cmd: string, timeout = 2500): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${SYS_PATH}:${process.env.PATH ?? ''}` }
    exec(cmd, { timeout, windowsHide: true, env }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

async function detectMac(): Promise<NetworkLink> {
  // Primary interface = the one carrying the default route.
  const routeOut = await run("route -n get default 2>/dev/null")
  const defaultDev = routeOut.match(/interface:\s*(\S+)/)?.[1] ?? ''

  // Which hardware-port device is the Wi-Fi radio.
  const ports = await run('networksetup -listallhardwareports')
  const wifiDev = ports.match(/Hardware Port:\s*Wi-Fi[\s\S]*?Device:\s*(\S+)/)?.[1] ?? ''

  if (defaultDev && wifiDev && defaultDev === wifiDev) {
    // `ipconfig getsummary` exposes the SSID WITHOUT Location Services, which
    // modern macOS (14/15+) now requires for `networksetup -getairportnetwork`
    // (it returns "You are not associated…" without the grant). Try it first.
    const summary = await run(`ipconfig getsummary ${wifiDev}`)
    const ssid = summary.match(/^\s*SSID\s*:\s*(.+)$/im)?.[1]?.trim()
    if (ssid) return { type: 'wifi', name: ssid }
    const ssidOut = await run(`networksetup -getairportnetwork ${wifiDev}`)
    const ssid2 = ssidOut.match(/Current Wi-Fi Network:\s*(.+)/)?.[1]?.trim()
    if (ssid2 && !/not associated/i.test(ssid2)) return { type: 'wifi', name: ssid2 }
    return { type: 'wifi', name: '' }
  }
  if (defaultDev) return { type: 'wired', name: '' }
  return { type: 'unknown', name: '' }
}

async function detectWindows(): Promise<NetworkLink> {
  const wlan = await run('netsh wlan show interfaces')
  if (/State\s*:\s*connected/i.test(wlan)) {
    const ssid = wlan.match(/^\s*SSID\s*:\s*(.+)$/im)?.[1]?.trim()
    if (ssid) return { type: 'wifi', name: ssid }
  }
  // No connected Wi-Fi → if anything routes, treat as wired.
  const route = await run('powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1).InterfaceAlias"')
  if (route.trim()) return { type: 'wired', name: '' }
  return { type: 'unknown', name: '' }
}

async function detectLinux(): Promise<NetworkLink> {
  const ssid = (await run('iwgetid -r')).trim()
  if (ssid) return { type: 'wifi', name: ssid }
  const nm = (await run("nmcli -t -f active,ssid dev wifi 2>/dev/null")).split('\n').find((l) => l.startsWith('yes:'))
  if (nm) return { type: 'wifi', name: nm.slice(4).trim() }
  const route = (await run("ip route show default 2>/dev/null")).trim()
  if (route) return { type: 'wired', name: '' }
  return { type: 'unknown', name: '' }
}

export async function detectLink(): Promise<NetworkLink> {
  try {
    if (process.platform === 'darwin') return await detectMac()
    if (process.platform === 'win32') return await detectWindows()
    return await detectLinux()
  } catch {
    return { type: 'unknown', name: '' }
  }
}
