import { describe, it, expect } from 'vitest'
import { whoHoldsPort, type PortProbe } from '../src/main/services/port-holder'

// What the operator is told when the capture port is already taken.
//
// mitmdump's own answer was a multi-line startup dump ending in a localised
// winsock error and a suggestion to pass `--mode regular@8082` — a mitmproxy
// flag, not a RedLog setting — so it named neither the holder nor the fact
// that the port is the operator's to change. On the machine this was found
// on, the holder was Burp Suite, whose default listener is 8080, which was
// also RedLog's default.
const probe = (free: boolean, holder: string | null = null): PortProbe => ({
  free: async () => free,
  holder: async () => holder
})

describe('whoHoldsPort', () => {
  it('says nothing when the endpoint is free', async () => {
    expect(await whoHoldsPort({ host: '127.0.0.1', port: 6661 }, probe(true))).toBeNull()
  })

  it('names the holder and the setting that moves the port', async () => {
    const msg = await whoHoldsPort({ host: '127.0.0.1', port: 8080 }, probe(false, 'BurpSuite.exe (PID 35632)'))
    expect(msg).toContain('127.0.0.1:8080')
    expect(msg).toContain('BurpSuite.exe (PID 35632)')
    expect(msg).toMatch(/Settings/)
  })

  it('still reports the clash when the holder cannot be named', async () => {
    const msg = await whoHoldsPort({ host: '0.0.0.0', port: 9090 }, probe(false, null))
    expect(msg).toContain('0.0.0.0:9090')
    expect(msg).toContain('already in use')
    // No dangling "by" with nothing after it.
    expect(msg).not.toMatch(/\bby\s*\./)
  })
})

// A force-quit or crash leaves RedLog's own mitmdump running with no parent.
// It holds the capture port, so the next launch refused to start HTTP capture
// until the operator found and killed it by hand. Only a process that is
// provably RedLog's leftover is reclaimed; anything else keeps the old message.
import { reclaimOrphanProxy, type OrphanDeps } from '../src/main/services/port-holder'

const ORPHAN = { ppid: 1, command: 'mitmdump --listen-host 127.0.0.1 --listen-port 6661 --set block_global=false -s /Applications/RedLog.app/Contents/Resources/hooks/mitmproxy-addon.py' }
const endpoint = { host: '127.0.0.1', port: 6661 }

function deps(over: Partial<OrphanDeps> & { info?: { ppid: number; command: string } | null; holderPid?: number | null } = {}): OrphanDeps & { killed: Array<[number, string]> } {
  const killed: Array<[number, string]> = []
  let alive = true
  return {
    killed,
    platform: 'darwin',
    pidOnPort: async () => (over.holderPid === undefined ? 4242 : over.holderPid),
    inspect: async () => (over.info === undefined ? ORPHAN : over.info),
    kill: (pid, signal) => { killed.push([pid, signal]); if (signal === 'SIGTERM') alive = false },
    portFree: async () => !alive,
    sleep: async () => {},
    ...over
  } as OrphanDeps & { killed: Array<[number, string]> }
}

describe('reclaimOrphanProxy', () => {
  it('stops a parentless mitmdump running RedLog\'s addon on that port', async () => {
    const d = deps()
    expect(await reclaimOrphanProxy(endpoint, d)).toEqual({ pid: 4242 })
    expect(d.killed).toEqual([[4242, 'SIGTERM']])
  })

  it('recognises the addon under an install path that contains spaces', async () => {
    const d = deps({ info: { ppid: 1, command: ORPHAN.command.replace('/Applications/RedLog.app', '/Users/Jo Doe/Apps/RedLog.app') } })
    expect(await reclaimOrphanProxy(endpoint, d)).toEqual({ pid: 4242 })
  })

  it('escalates to SIGKILL only when SIGTERM did not free the port', async () => {
    const d = deps()
    let freed = false
    d.kill = (pid, signal) => { d.killed.push([pid, signal]); if (signal === 'SIGKILL') freed = true }
    d.portFree = async () => freed
    expect(await reclaimOrphanProxy(endpoint, d)).toEqual({ pid: 4242 })
    expect(d.killed.map((k) => k[1])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it.each([
    ['a mitmdump that still has a parent', { ppid: 812, command: ORPHAN.command }],
    ['a mitmdump running someone else\'s addon', { ppid: 1, command: 'mitmdump --listen-port 6661 -s /home/op/my-addon.py' }],
    ['a different port than the one we need', { ppid: 1, command: ORPHAN.command.replace('6661', '7777') }],
    ['Burp Suite on the port', { ppid: 1, command: '/Applications/Burp Suite/jre/bin/java -jar burpsuite.jar --listen-port 6661 mitmproxy-addon.py' }]
  ])('leaves %s alone', async (_name, info) => {
    const d = deps({ info })
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
    expect(d.killed).toEqual([])
  })

  it('does nothing on Windows, where a parent id says nothing about being orphaned', async () => {
    const d = deps({ platform: 'win32' })
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
    expect(d.killed).toEqual([])
  })

  it('does nothing when the holder cannot be identified', async () => {
    expect(await reclaimOrphanProxy(endpoint, deps({ holderPid: null }))).toBeNull()
    const d = deps({ info: null })
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
    expect(d.killed).toEqual([])
  })

  it('reports nothing reclaimed when the process cannot be stopped', async () => {
    const d = deps()
    d.kill = (pid, signal) => { d.killed.push([pid, signal]) }
    d.portFree = async () => false
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
  })
})
