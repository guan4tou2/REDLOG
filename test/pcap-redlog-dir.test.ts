import { describe, it, expect } from 'vitest'
import path from 'path'
import { createRequire } from 'module'
const { resolveRedlogDir, homeFromPasswd } = createRequire(import.meta.url)('../plugins/pcap-capture/redlog-dir.js')

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/zsh\nbad:x:1001:1001::relative/home:/bin/sh\n'
const lookup = (u: string) => homeFromPasswd(PASSWD, u)
const base = { homedir: '/root', platform: 'linux', lookup }

describe('pcap-capture redlog dir', () => {
  it('uses the sudo invoker home when running as root', () => {
    expect(resolveRedlogDir({ ...base, uid: 0, env: { SUDO_USER: 'alice' } })).toBe(path.join('/home/alice', '.redlog'))
  })
  it('ignores SUDO_USER when not root', () => {
    expect(resolveRedlogDir({ ...base, uid: 1000, homedir: '/home/bob', env: { SUDO_USER: 'alice' } })).toBe(path.join('/home/bob', '.redlog'))
  })
  it('falls back for unknown users, root, relative homes and non-plain names', () => {
    for (const u of ['ghost', 'root', 'bad', '../alice', 'alice;id', 'alice\n', '']) {
      expect(resolveRedlogDir({ ...base, uid: 0, env: { SUDO_USER: u } }), u).toBe(path.join('/root', '.redlog'))
    }
  })
  it('never hands a rejected name to the lookup', () => {
    const seen: string[] = []
    resolveRedlogDir({ ...base, uid: 0, env: { SUDO_USER: '$(id)' }, lookup: (u: string) => { seen.push(u); return '/x' } })
    expect(seen).toEqual([])
  })
  it('falls back when the lookup throws', () => {
    expect(resolveRedlogDir({ ...base, uid: 0, env: { SUDO_USER: 'alice' }, lookup: () => { throw new Error('no dscl') } })).toBe(path.join('/root', '.redlog'))
  })
  it('matches the passwd name exactly', () => {
    expect(homeFromPasswd(PASSWD, 'alic')).toBeNull()
    expect(homeFromPasswd(PASSWD, 'alice')).toBe('/home/alice')
  })
})
