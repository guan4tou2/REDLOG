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
// until the operator found and killed it by hand. Only a process RedLog itself
// recorded is reclaimed — pid, endpoint, exact addon path and process start
// time — because a command line alone is not proof: another person's mitmdump
// can carry the same addon file name, and a pid can be reused after a reboot.
import { reclaimOrphanProxy, recordProxyOwner, type OrphanDeps, type ProxyOwner } from '../src/main/services/port-holder'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ADDON = '/Applications/RedLog.app/Contents/Resources/hooks/mitmproxy-addon.py'
const OWNER: ProxyOwner = { pid: 4242, host: '127.0.0.1', port: 6661, addonPath: ADDON, startedAt: 'Sun Oct 18 15:02:11 2026' }
const ORPHAN = { ppid: 1, command: `mitmdump --listen-host 127.0.0.1 --listen-port 6661 --set block_global=false -s ${ADDON}` }
const endpoint = { host: '127.0.0.1', port: 6661 }

type Over = Partial<OrphanDeps> & {
  info?: { ppid: number; command: string } | null
  holderPid?: number | null
  owner?: ProxyOwner | null
  startedAt?: string | null
}

function deps(over: Over = {}): OrphanDeps & { killed: Array<[number, string]>; cleared: number } {
  const killed: Array<[number, string]> = []
  let alive = true
  const d = {
    killed,
    cleared: 0,
    platform: over.platform ?? 'darwin',
    owner: async () => (over.owner === undefined ? OWNER : over.owner),
    startedAt: async () => (over.startedAt === undefined ? OWNER.startedAt : over.startedAt),
    clearOwner: () => { d.cleared++ },
    pidOnPort: async () => (over.holderPid === undefined ? 4242 : over.holderPid),
    inspect: async () => (over.info === undefined ? ORPHAN : over.info),
    kill: (pid: number, signal: string) => { killed.push([pid, signal]); if (signal === 'SIGTERM') alive = false },
    portFree: async () => !alive,
    sleep: async () => {}
  }
  return d as unknown as OrphanDeps & { killed: Array<[number, string]>; cleared: number }
}

describe('reclaimOrphanProxy', () => {
  it('stops a parentless mitmdump that RedLog recorded, and forgets the record', async () => {
    const d = deps()
    expect(await reclaimOrphanProxy(endpoint, d)).toEqual({ pid: 4242 })
    expect(d.killed).toEqual([[4242, 'SIGTERM']])
    expect(d.cleared).toBe(1)
  })

  it('recognises the addon under an install path that contains spaces', async () => {
    const addon = '/Users/Jo Doe/Apps/RedLog.app/hooks/mitmproxy-addon.py'
    const d = deps({ owner: { ...OWNER, addonPath: addon }, info: { ppid: 1, command: ORPHAN.command.replace(ADDON, addon) } })
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
    ['no record of RedLog having started one', { owner: null }],
    ['a record for another pid', { owner: { ...OWNER, pid: 999 } }],
    ['a record for another port', { owner: { ...OWNER, port: 7777 } }],
    ['a record for another host', { owner: { ...OWNER, host: '0.0.0.0' } }],
    ['the right pid started at another time — a reused pid', { startedAt: 'Mon Oct 19 09:00:00 2026' }],
    ['a pid whose start time cannot be read', { startedAt: null }],
    ['a mitmdump that still has a parent', { info: { ppid: 812, command: ORPHAN.command } }],
    ['the same addon file name in another directory', { info: { ppid: 1, command: ORPHAN.command.replace(ADDON, '/home/op/tools/mitmproxy-addon.py') } }],
    ['someone else\'s addon', { info: { ppid: 1, command: 'mitmdump --listen-port 6661 -s /home/op/my-addon.py' } }],
    ['a different port than the one we need', { info: { ppid: 1, command: ORPHAN.command.replace('6661', '7777') } }],
    ['Burp Suite on the port', { info: { ppid: 1, command: `/Applications/Burp Suite/jre/bin/java -jar burpsuite.jar --listen-port 6661 ${ADDON}` } }]
  ] as Array<[string, Over]>)('leaves %s alone', async (_name, over) => {
    const d = deps(over)
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
    expect(d.killed).toEqual([])
    expect(d.cleared).toBe(0)
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

  it('reports nothing reclaimed, and keeps the record, when the process cannot be stopped', async () => {
    const d = deps()
    d.kill = (pid, signal) => { d.killed.push([pid, signal]) }
    d.portFree = async () => false
    expect(await reclaimOrphanProxy(endpoint, d)).toBeNull()
    expect(d.cleared).toBe(0)
  })
})

describe('recordProxyOwner', () => {
  it('writes the pid, endpoint, addon path and start time where the next launch reads them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-owner-'))
    try {
      const file = path.join(dir, '.redlog', 'owner.json')
      await recordProxyOwner(file, { pid: 4242, host: '127.0.0.1', port: 6661, addonPath: ADDON }, async () => OWNER.startedAt)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(OWNER)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('writes nothing when the start time cannot be read, so nothing can be reclaimed on a guess', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-owner-'))
    try {
      const file = path.join(dir, 'owner.json')
      await recordProxyOwner(file, { pid: 1, host: 'h', port: 1, addonPath: 'a' }, async () => null)
      expect(fs.existsSync(file)).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
