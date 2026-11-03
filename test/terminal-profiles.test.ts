import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  registerTerminalProfiles, unregisterTerminalProfiles, syncTerminalProfiles, readContributedProfiles,
  ADAPTER_RESERVED
} from '../src/core/terminal-profiles'
import { compileClassPolicy, CLASS_FILE_MAX_BYTES, type CompiledClassPolicy } from '../src/core/terminal-class'
import { readClassOverlay } from '../src/core/terminal-enrollment'
import shipped from '../hooks/command-class.json'

// #499. A plugin manifest may contribute `terminalProfiles`. RedLog validates
// them, namespaces their ids, and writes ~/.redlog/terminal-profiles.json for
// the compilers to read next to the operator's overlay. Nothing here compiles:
// what a profile does to a command's mode is test/command-class.test.ts's.

let home: string
let registered: string[]
const file = (): string => path.join(home, '.redlog', 'terminal-profiles.json')
const text = (): string => fs.readFileSync(file(), 'utf8')

const profile = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'brings its own PTY', ...over })

/** Register through the real entry point, remembering the plugin for cleanup. */
const register = (pluginId: string, raw: unknown) => {
  registered.push(pluginId)
  return registerTerminalProfiles(pluginId, raw)
}
const compiled = (): CompiledClassPolicy => compileClassPolicy(null, undefined, readContributedProfiles(home))
const entry = (p: CompiledClassPolicy, command: string) => p.entries.find((e) => e.command === command)

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tprof-'))
  registered = []
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const id of registered) unregisterTerminalProfiles(id)
  fs.rmSync(home, { recursive: true, force: true })
})

describe('registering a plugin\'s terminal profiles', () => {
  it('accepts a profile and counts it', () => {
    expect(register('red-team-pack', [profile()])).toEqual({ accepted: 1, rejected: [] })
  })

  it('namespaces the id with the plugin id, and writes the same shape a bundled profile has', () => {
    register('red-team-pack', [profile()])
    expect(syncTerminalProfiles(home)).toEqual({ written: true })
    expect(JSON.parse(text()).profiles).toEqual([
      { id: 'red-team-pack/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'brings its own PTY' }
    ])
  })

  it('names every rejection, drops the profile whole, and keeps the rest', () => {
    const r = register('pack', [
      'text',
      profile({ id: 'Bad Id' }),
      profile({ id: 'dup' }),
      profile({ id: 'dup', executables: ['other'] }),
      profile({ id: 'noname', name: '' }),
      profile({ id: 'colon', name: 'a: b' }),
      profile({ id: 'ctl', name: 'a\nb' }),
      profile({ id: 'longname', name: 'x'.repeat(65) }),
      profile({ id: 'nomode', mode: 'sideways' }),
      profile({ id: 'noexes', executables: [] }),
      profile({ id: 'exesnotlist', executables: 'x' }),
      profile({ id: 'exesnotstring', executables: ['x', 1] }),
      profile({ id: 'semi', executables: ['a;b'] }),
      profile({ id: 'slash', executables: ['/usr/bin/x'] }),
      profile({ id: 'sameexe', executables: ['y', 'y'] }),
      profile({ id: 'manyexes', executables: Array.from({ length: 17 }, (_, i) => `t${i}`) }),
      profile({ id: 'sudoish', executables: ['ok', 'sudo'] }),
      profile({ id: 'ncpty', executables: ['nc'] }),
      profile({ id: 'socatnative', mode: 'native', executables: ['socat'] }),
      profile({ id: 'noreason', reason: '' }),
      profile({ id: 'longreason', reason: 'x'.repeat(201) }),
      profile({ id: 'good', executables: ['fine'] })
    ])
    expect(r.accepted).toBe(2) // the first `dup` and `good`
    expect(r.rejected).toEqual([
      { name: '#0', reason: 'not an object' },
      { name: 'Bad Id', reason: 'id must be lowercase letters, digits and hyphens' },
      { name: 'dup', reason: 'duplicate id' },
      { name: 'noname', reason: 'name must be one short line with no colon' },
      { name: 'colon', reason: 'name must be one short line with no colon' },
      { name: 'ctl', reason: 'name must be one short line with no colon' },
      { name: 'longname', reason: 'name must be one short line with no colon' },
      { name: 'nomode', reason: 'mode must be native, pty or relayed' },
      { name: 'noexes', reason: 'executables must be bare command names' },
      { name: 'exesnotlist', reason: 'executables must be bare command names' },
      { name: 'exesnotstring', reason: 'executables must be bare command names' },
      { name: 'semi', reason: 'executables must be bare command names' },
      { name: 'slash', reason: 'executables must be bare command names' },
      { name: 'sameexe', reason: 'executables must be bare command names' },
      { name: 'manyexes', reason: 'executables must be bare command names' },
      { name: 'sudoish', reason: 'sudo is used by RedLog\'s shell adapter' },
      { name: 'ncpty', reason: 'nc is a shipped native default; change it with redlog class add' },
      { name: 'socatnative', reason: 'socat is a shipped pty default; change it with redlog class add' },
      { name: 'noreason', reason: 'reason is required' },
      { name: 'longreason', reason: 'reason is required' }
    ])
    syncTerminalProfiles(home)
    expect(JSON.parse(text()).profiles.map((p: { id: string }) => p.id)).toEqual(['pack/dup', 'pack/good'])
  })

  // A name is printed by `redlog class list`. A lone surrogate cannot be encoded
  // as UTF-8, so Python's stdout raises on it and the listing stops mid-line;
  // DEL, the C1 controls and U+2028/2029 are line breaks or terminal controls
  // that a "one short line" name must not carry.
  it('refuses a name that is not well-formed text or carries a control character', () => {
    const bad: Record<string, string> = {
      loneHigh: 'Ligolo\ud800', loneLow: '\udc00Ligolo', swapped: 'a\udc00\ud800b',
      del: 'a\u007fb', c1Low: 'a\u0080b', c1High: 'a\u009fb', ls: 'a\u2028b', ps: 'a\u2029b'
    }
    const r = register('pack', [
      ...Object.entries(bad).map(([id, name]) => profile({ id: id.toLowerCase(), name, executables: [`x${id.toLowerCase()}`] })),
      profile({ id: 'astral', name: 'Ligolo \u{1F6F0} ng', executables: ['xastral'] }),
      profile({ id: 'accent', name: 'Ligolo \u00a0\u00e9\u00a1', executables: ['xaccent'] })
    ])
    expect(r.rejected.map((x) => x.name)).toEqual(Object.keys(bad).map((k) => k.toLowerCase()))
    expect(new Set(r.rejected.map((x) => x.reason))).toEqual(new Set(['name must be one short line with no colon']))
    expect(r.accepted).toBe(2)
  })

  it('names an entry whose id is unusable by its position', () => {
    expect(register('pack', [{ mode: 'pty' }, { id: 7 }]).rejected).toEqual([
      { name: '#0', reason: 'id must be lowercase letters, digits and hyphens' },
      { name: '#1', reason: 'id must be lowercase letters, digits and hyphens' }
    ])
  })

  it('refuses every name the shell adapter itself runs, in every mode, and builds the list from the policy file', () => {
    for (const mode of ['native', 'pty', 'relayed']) {
      for (const exe of ['sudo', 'env', 'proxychains', 'python3', 'node', 'redlog', 'curl', 'rm', 'cmd.exe', 'echo', 'command', 'wslpath']) {
        expect(register('pack', [profile({ id: 'x', mode, executables: [exe] })]).rejected, `${mode} ${exe}`)
          .toEqual([{ name: 'x', reason: `${exe} is used by RedLog's shell adapter` }])
      }
    }
    // Read from the file the compilers read, so a new wrapper or REPL is reserved with no edit here.
    for (const w of Object.keys(shipped.wrappers)) expect(ADAPTER_RESERVED.has(w), w).toBe(true)
    for (const r of shipped.repl) expect(ADAPTER_RESERVED.has(r), r).toBe(true)
  })

  it('shipped profiles use no name the adapter needs', () => {
    for (const p of shipped.terminalProfiles) {
      for (const exe of p.executables) expect(ADAPTER_RESERVED.has(exe), `${p.id}: ${exe}`).toBe(false)
    }
  })

  it('lets a plugin repeat a shipped default in the mode it already has', () => {
    expect(register('pack', [
      profile({ id: 'netcat', mode: 'native', executables: ['nc'] }),
      profile({ id: 'sock', mode: 'pty', executables: ['socat'] })
    ])).toEqual({ accepted: 2, rejected: [] })
  })

  it('takes 32 profiles and rejects the 33rd onward as too many', () => {
    const many = Array.from({ length: 34 }, (_, i) => profile({ id: `p${i}`, executables: [`tool${i}`] }))
    const r = register('pack', many)
    expect(r.accepted).toBe(32)
    expect(r.rejected).toEqual([{ name: 'p32', reason: 'too many profiles' }, { name: 'p33', reason: 'too many profiles' }])
  })

  it('takes 16 executables, and unique ones', () => {
    expect(register('pack', [profile({ executables: Array.from({ length: 16 }, (_, i) => `t${i}`) })]).accepted).toBe(1)
  })

  it('forgets a plugin on unregister', () => {
    register('pack', [profile()])
    unregisterTerminalProfiles('pack')
    syncTerminalProfiles(home)
    expect(fs.existsSync(file())).toBe(false)
  })

  it('re-registering a plugin replaces its profiles', () => {
    register('pack', [profile()])
    register('pack', [profile({ id: 'other', executables: ['other'] })])
    syncTerminalProfiles(home)
    expect(JSON.parse(text()).profiles.map((p: { id: string }) => p.id)).toEqual(['pack/other'])
  })
})

describe('reading the snapshot', () => {
  it('is null when there is no file, false when it cannot be read or parsed, else what it parsed to', () => {
    expect(readContributedProfiles(home)).toBeNull()
    fs.mkdirSync(path.join(home, '.redlog'))
    fs.writeFileSync(file(), '{')
    expect(readContributedProfiles(home)).toBe(false)
    fs.writeFileSync(file(), '')
    expect(readContributedProfiles(home)).toBe(false)
    fs.writeFileSync(file(), '{"version":1}')
    expect(readContributedProfiles(home)).toEqual({ version: 1 })
    fs.writeFileSync(file(), 'null')
    expect(readContributedProfiles(home)).toBeNull()
  })

  it('is false, not null, when the path is not a readable file', () => {
    fs.mkdirSync(file(), { recursive: true })
    expect(readContributedProfiles(home)).toBe(false)
  })
})

describe('writing the snapshot', () => {
  it('writes no file when no plugin contributes a profile, and deletes a stale one', () => {
    expect(syncTerminalProfiles(home)).toEqual({ written: false })
    expect(fs.existsSync(file())).toBe(false)
    fs.mkdirSync(path.join(home, '.redlog'))
    fs.writeFileSync(file(), '{"version":1,"profiles":[],"held":{"vim":"vim"}}')
    expect(syncTerminalProfiles(home)).toEqual({ written: false })
    expect(fs.existsSync(file())).toBe(false)
  })

  it('writes the exact format: version, the plugins\' profiles, and who holds what, keys sorted', () => {
    register('red-team-pack', [profile()])
    syncTerminalProfiles(home)
    expect(text()).toBe(JSON.stringify({
      version: 1,
      profiles: [{ id: 'red-team-pack/ligolo', name: 'Ligolo-ng', mode: 'pty', executables: ['ligolo-proxy'], reason: 'brings its own PTY' }],
      held: {
        claude: 'claude-code', codex: 'codex', 'ligolo-proxy': 'red-team-pack/ligolo',
        'pwncat-cs': 'pwncat-cs', ssh: 'ssh', vi: 'vim', vim: 'vim'
      }
    }, null, 2) + '\n')
    expect(text().charCodeAt(0)).not.toBe(0xfeff)
  })

  it('orders profiles by plugin id, then by the manifest\'s own order', () => {
    register('zeta', [profile({ id: 'one', executables: ['z1'] }), profile({ id: 'two', executables: ['z2'] })])
    register('alpha', [profile({ id: 'one', executables: ['a1'] })])
    syncTerminalProfiles(home)
    expect(JSON.parse(text()).profiles.map((p: { id: string }) => p.id)).toEqual(['alpha/one', 'zeta/one', 'zeta/two'])
  })

  it('writes the same bytes twice, and does not touch the file the second time', () => {
    register('pack', [profile()])
    syncTerminalProfiles(home)
    const first = text()
    const past = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(file(), past, past)
    expect(syncTerminalProfiles(home)).toEqual({ written: false })
    expect(text()).toBe(first)
    expect(fs.statSync(file()).mtimeMs).toBe(past.getTime())
  })

  it('leaves no .part file behind', () => {
    register('pack', [profile()])
    syncTerminalProfiles(home)
    expect(fs.readdirSync(path.join(home, '.redlog'))).toEqual(['terminal-profiles.json'])
  })

  it('reports an error and writes nothing when the directory cannot be made', () => {
    fs.writeFileSync(path.join(home, '.redlog'), 'a file where the directory belongs')
    register('pack', [profile()])
    const r = syncTerminalProfiles(home)
    expect(r.written).toBe(false)
    expect(r.error).toBeTruthy()
  })

  // Removing the file when the last plugin goes is the same race as replacing
  // it: the relay can hold it open for a moment, and an unlink Windows refuses
  // would leave a snapshot of plugins that are gone.
  it('retries an unlink that Windows refuses, then keeps the file and says so', () => {
    register('pack', [profile()])
    syncTerminalProfiles(home)
    const old = text()
    unregisterTerminalProfiles('pack')
    const real = fs.unlinkSync
    let calls = 0
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
      calls += 1
      if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' })
      real(p)
    })
    expect(syncTerminalProfiles(home)).toEqual({ written: false })
    expect(calls).toBe(3)
    expect(fs.existsSync(path.join(home, '.redlog', 'terminal-profiles.json'))).toBe(false)

    vi.restoreAllMocks()
    register('pack', [profile()])
    syncTerminalProfiles(home)
    expect(text()).toBe(old)
    unregisterTerminalProfiles('pack')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('held'), { code: 'EACCES' }) })
    const r = syncTerminalProfiles(home)
    vi.restoreAllMocks()
    expect(r.written).toBe(false)
    expect(r.error).toMatch(/held/)
    expect(text()).toBe(old)
  })

  it('does not retry an unlink that fails for another reason', () => {
    register('pack', [profile()])
    syncTerminalProfiles(home)
    unregisterTerminalProfiles('pack')
    let calls = 0
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { calls += 1; throw Object.assign(new Error('is a directory'), { code: 'EISDIR' }) })
    const r = syncTerminalProfiles(home)
    vi.restoreAllMocks()
    expect(calls).toBe(1)
    expect(r.error).toMatch(/is a directory/)
  })

  it('retries a rename that Windows refuses, then keeps the old file and says so', () => {
    register('pack', [profile()])
    syncTerminalProfiles(home)
    const old = text()
    register('pack', [profile(), profile({ id: 'more', executables: ['moretool'] })])
    const real = fs.renameSync
    let calls = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      calls += 1
      if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' })
      real(a, b)
    })
    expect(syncTerminalProfiles(home)).toEqual({ written: true })
    expect(calls).toBe(3)

    vi.restoreAllMocks()
    register('pack', [profile()])
    syncTerminalProfiles(home)
    expect(text()).toBe(old)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
    register('pack', [profile(), profile({ id: 'again', executables: ['again'] })])
    const r = syncTerminalProfiles(home)
    expect(r.written).toBe(false)
    expect(r.error).toMatch(/busy/)
    vi.restoreAllMocks()
    expect(text()).toBe(old)
  })
})

// The forward rule: the claim in effect stays. The writer is where "in effect"
// is remembered, because it is the only thing that sees both the previous
// file and the plugins as they are now.
describe('who keeps a command across writes', () => {
  const P = (): Record<string, unknown> => profile({ id: 'p', mode: 'pty', executables: ['x'] })
  const Q = (): Record<string, unknown> => profile({ id: 'q', mode: 'native', executables: ['x'] })
  const heldNow = (): Record<string, string> => JSON.parse(text()).held

  it('a plugin that arrives after a bundled tool does not take its command', () => {
    // A bundled profile's executables are also in the shipped native/pty list
    // (so a relay from before profiles reads the right class), which makes vim
    // part of the floor a plugin cannot move: it is refused at registration, so
    // there is nothing to hold and no clash to report, now or on any later write.
    const r = register('keys', [profile({ id: 'vimkeys', mode: 'pty', executables: ['vim'] })])
    expect(r.accepted).toBe(0)
    expect(JSON.stringify(r.rejected)).toMatch(/vim is a shipped native default/)
    expect(syncTerminalProfiles(home).written).toBe(false)
    expect(fs.existsSync(file())).toBe(false)
    const p = compiled()
    expect(entry(p, 'vim')).toMatchObject({ mode: 'native', source: 'profile', profile: 'vim' })
    expect(p.problems).toEqual([])
    syncTerminalProfiles(home)
    expect(fs.existsSync(file())).toBe(false)
  })

  it('the first plugin to hold a command keeps it, whichever order they are added in', () => {
    register('aaa', [P()])
    syncTerminalProfiles(home)
    register('bbb', [Q()])
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('aaa/p')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'pty', profile: 'aaa/p' })

    unregisterTerminalProfiles('aaa')
    unregisterTerminalProfiles('bbb')
    fs.rmSync(file())
    register('bbb', [Q()])
    syncTerminalProfiles(home)
    register('aaa', [P()])
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('bbb/q')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'native', profile: 'bbb/q' })
  })

  it('two plugins that arrive in one write cancel out, and the command stays relayed', () => {
    register('aaa', [P()])
    register('bbb', [Q()])
    syncTerminalProfiles(home)
    expect(heldNow()).not.toHaveProperty('x')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'relayed', source: 'fallback' })
    expect(compiled().problems).toEqual([expect.objectContaining({ kind: 'conflict', command: 'x' })])
  })

  it('removing the holder hands the command to the plugin that is left', () => {
    register('aaa', [P()])
    syncTerminalProfiles(home)
    register('bbb', [Q()])
    syncTerminalProfiles(home)
    unregisterTerminalProfiles('aaa')
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('bbb/q')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'native', profile: 'bbb/q' })
    expect(compiled().problems).toEqual([])
  })

  it('a plugin disabled and enabled again is a newcomer', () => {
    register('aaa', [P()])
    register('bbb', [Q()])
    syncTerminalProfiles(home) // both new: cancelled
    unregisterTerminalProfiles('aaa')
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('bbb/q')
    register('aaa', [P()])
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('bbb/q')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'native', profile: 'bbb/q' })
  })

  it('a corrupt previous file is no history: nobody is the incumbent, and the file is rewritten', () => {
    register('aaa', [P()])
    register('bbb', [Q()])
    fs.mkdirSync(path.join(home, '.redlog'))
    fs.writeFileSync(file(), '{"version":1,"profiles":"nope"')
    expect(syncTerminalProfiles(home)).toEqual({ written: true })
    // Both are newcomers, so they cancel out; the unreadable file made neither the holder.
    expect(heldNow()).not.toHaveProperty('x')
    expect(JSON.parse(text()).profiles).toHaveLength(2)
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'relayed', source: 'fallback' })
    // A snapshot a newer RedLog wrote is no history either, whoever it names.
    fs.writeFileSync(file(), '{"version":2,"profiles":[],"held":{"x":"aaa/p"}}')
    syncTerminalProfiles(home)
    expect(heldNow()).not.toHaveProperty('x')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'relayed', source: 'fallback' })
  })

  it('a holder that changes its own mode keeps the command in the new mode', () => {
    register('aaa', [P()])
    syncTerminalProfiles(home)
    register('bbb', [Q()])
    syncTerminalProfiles(home)
    register('aaa', [profile({ id: 'p', mode: 'native', executables: ['x'] })])
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('aaa/p')
    expect(entry(compiled(), 'x')).toMatchObject({ mode: 'native', profile: 'aaa/p' })
    expect(compiled().problems).toEqual([])
  })

  it('a command only the operator\'s overlay names does not move held', () => {
    register('aaa', [P()])
    syncTerminalProfiles(home)
    fs.writeFileSync(path.join(home, '.redlog', 'command-class.json'), '{"relayed":["x"]}')
    syncTerminalProfiles(home)
    expect(heldNow().x).toBe('aaa/p')
  })
})

// The two files the policy reads from ~/.redlog are read with a size cap, and a
// file nested too deep is not a crash. The shell reads them the same way
// (hooks/redlog-relay.py `read_json_capped`); test/command-class.test.ts runs
// the same files through both.
describe('reading the files the policy reads', () => {
  const put = (name: string, body: string): void => {
    fs.mkdirSync(path.join(home, '.redlog'), { recursive: true })
    fs.writeFileSync(path.join(home, '.redlog', name), body)
  }
  const padded = (body: string, bytes: number): string => body + ' '.repeat(bytes - Buffer.byteLength(body))
  const nested = '['.repeat(200000) + ']'.repeat(200000)

  it('reads the snapshot at the cap, and as unreadable one byte over it', () => {
    const body = JSON.stringify({ version: 1, profiles: [], held: {} })
    put('terminal-profiles.json', padded(body, CLASS_FILE_MAX_BYTES))
    expect(readContributedProfiles(home)).toEqual({ version: 1, profiles: [], held: {} })
    put('terminal-profiles.json', padded(body, CLASS_FILE_MAX_BYTES + 1))
    expect(readContributedProfiles(home)).toBe(false)
  })

  it('reads a snapshot nested too deep as unreadable', () => {
    put('terminal-profiles.json', nested)
    expect(readContributedProfiles(home)).toBe(false)
  })

  it('does the same for the operator\'s overlay: at the cap it is read, over it or too deep it is no overlay', () => {
    const body = '{"pty":["ok"]}'
    put('command-class.json', padded(body, CLASS_FILE_MAX_BYTES))
    expect(readClassOverlay(home)).toEqual({ pty: ['ok'] })
    put('command-class.json', padded(body, CLASS_FILE_MAX_BYTES + 1))
    expect(readClassOverlay(home)).toBeNull()
    put('command-class.json', nested)
    expect(readClassOverlay(home)).toBeNull()
  })

  // A byte that is not UTF-8 makes a file that cannot be read, not a file with a
  // replacement character in it: the shell's reader (strict decode) refuses it,
  // and the app must give the same answer about the same file.
  it('reads a file with a byte that is not UTF-8 as unreadable, the snapshot and the overlay alike', () => {
    const snapshot = (reason: Buffer): Buffer => Buffer.concat([
      Buffer.from('{"version":1,"profiles":[{"id":"p/x","name":"X","mode":"pty","executables":["zzz"],"reason":"'), reason,
      Buffer.from('"}],"held":{}}')
    ])
    const putBytes = (name: string, bytes: Buffer): void => {
      fs.mkdirSync(path.join(home, '.redlog'), { recursive: true })
      fs.writeFileSync(path.join(home, '.redlog', name), bytes)
    }
    putBytes('terminal-profiles.json', snapshot(Buffer.from('plain')))
    expect(readContributedProfiles(home)).not.toBe(false)
    for (const bad of [[0xff], [0xe4, 0xb8], [0xed, 0xa0, 0x80], [0xc0, 0xaf]]) {
      putBytes('terminal-profiles.json', snapshot(Buffer.from(bad)))
      expect(readContributedProfiles(home), `snapshot with ${bad.map((b) => b.toString(16))}`).toBe(false)
      putBytes('command-class.json', Buffer.concat([Buffer.from('{"pty":["ok"],"note":"'), Buffer.from(bad), Buffer.from('"}')]))
      expect(readClassOverlay(home), `overlay with ${bad.map((b) => b.toString(16))}`).toBeNull()
    }
    // multibyte text that is valid is read, and so is nothing wrong with a BOM-free file
    putBytes('command-class.json', Buffer.from('{"pty":["ok"],"note":"café 中文"}'))
    expect(readClassOverlay(home)).toMatchObject({ pty: ['ok'] })
    // a byte order mark is not JSON, as it is not for the shell's parser
    putBytes('command-class.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"pty":["ok"]}')]))
    expect(readClassOverlay(home)).toBeNull()
  })

  it('drops from the overlay a name that is not a bare command name, and says so once per field', () => {
    const p = compileClassPolicy({ pty: ['curl', 'a;b', 'x y', 'x\n', '-x', ''], native: ['$(id)'], relayed: ['ok.tool'] })
    expect(p.pty).toContain('curl')
    expect(p.pty.join(' ')).not.toMatch(/a;b|x y|\n|-x/)
    expect(p.native).not.toContain('$(id)')
    expect(p.problems).toEqual([{ kind: 'invalid-overlay-names', field: 'native' }, { kind: 'invalid-overlay-names', field: 'pty' }])
  })
})
