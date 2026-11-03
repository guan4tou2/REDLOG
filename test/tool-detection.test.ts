import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createToolDetector, rescanTrigger, type ToolDetectionSnapshot } from '../src/core/tool-detection'
import { classifyCommand, compileClassPolicy, knownProfiles, type TerminalProfile } from '../src/core/terminal-class'
import { readClassOverlay } from '../src/core/terminal-enrollment'
import shipped from '../hooks/command-class.json'
import golden from './fixtures/command-class-golden.json'

// #499 PR B. What this machine has, shown beside what a tool profile decides,
// and never the other way round. The rules (issue #499): no scanner that keeps
// running, a lookup only on a named trigger and never per command, and a miss
// must not remove or change an effective profile. Detection is its own state.

const profile = (id: string, executables: string[], mode: TerminalProfile['mode'] = 'native'): TerminalProfile =>
  ({ id, name: id, mode, executables, reason: 'r' })
const PROFILES = [profile('vim', ['vim', 'vi']), profile('claude-code', ['claude']), profile('codex', ['codex']), profile('ssh', ['ssh'], 'pty')]

const DAY = 86_400_000
let home: string
let reportDir: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tooldet-'))
  reportDir = path.join(home, '.redlog', 'tool-detection')
  fs.mkdirSync(reportDir, { recursive: true })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1, environment: 'shell:linux:kali-linux:zsh', platform: 'linux', wslDistro: 'kali-linux', shell: 'zsh',
  sessionId: 's1', detectedAt: 1_000_000, checked: ['claude', 'codex', 'ssh', 'vi', 'vim'], found: { vim: '/usr/bin/vim' }, ...over
})
const writeReport = (name: string, body: unknown, raw = false): string => {
  const file = path.join(reportDir, `${name}.json`)
  fs.writeFileSync(file, raw ? String(body) : JSON.stringify(body))
  return file
}

interface Harness {
  calls: string[]
  lookup: (cmd: string) => Promise<string | null>
  release: () => void
}
/** A lookup that answers from a table and counts every name it is asked. With
 *  `gate`, every answer waits for `release()`. */
const fakeLookup = (table: Record<string, string>, gate = false): Harness => {
  const calls: string[] = []
  let release = (): void => {}
  const open = new Promise<void>((resolve) => { release = resolve })
  return {
    calls, release: () => release(),
    lookup: async (cmd) => { calls.push(cmd); if (gate) await open; return table[cmd] ?? null }
  }
}

const stateOf = (snap: ToolDetectionSnapshot, envId: string, id: string): string | undefined =>
  snap.environments.find((e) => e.id === envId)?.profiles.find((p) => p.profile === id)?.state

describe('the app lookup', () => {
  it('joins what is on PATH to the profile that owns the executable', async () => {
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const win = process.platform === 'win32'
    const make = (n: string): string => {
      const p = path.join(bin, win ? `${n}.EXE` : n)
      fs.writeFileSync(p, ''); fs.chmodSync(p, 0o755)
      return p
    }
    const vim = make('vim'); make('claude')
    const env = win ? { Path: bin, PATHEXT: '.EXE' } : { PATH: bin }
    const detector = createToolDetector({ home, platform: process.platform, env: () => env, profiles: () => PROFILES })
    const snap = await detector.rescan('manual')

    const app = snap.environments[0]
    expect(app).toMatchObject({ id: `app:${process.platform}`, source: 'app', platform: process.platform, stale: false })
    expect(app.profiles.find((p) => p.profile === 'vim')).toEqual({
      profile: 'vim', state: 'found',
      executables: [{ name: 'vim', state: 'found', path: vim }, { name: 'vi', state: 'missing' }]
    })
    expect(stateOf(snap, app.id, 'claude-code')).toBe('found')
    expect(stateOf(snap, app.id, 'codex')).toBe('missing')
    expect(snap.lastTrigger).toBe('manual')
    expect(snap.scanning).toBe(false)
  })

  it('has nothing to show before the first lookup, and does not look anything up to find out', async () => {
    const h = fakeLookup({ vim: '/usr/bin/vim' })
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({ PATH: '/usr/bin' }), profiles: () => PROFILES, lookup: h.lookup })
    expect(await detector.snapshot()).toEqual({ environments: [], scanning: false, lastTrigger: null })
    expect(h.calls).toEqual([])
  })

  it('reads the environment when it scans, not when it was created', async () => {
    const seen: Array<string | undefined> = []
    const env: NodeJS.ProcessEnv = { PATH: '/before' }
    const detector = createToolDetector({
      home, platform: 'linux', env: () => env, profiles: () => PROFILES,
      lookup: async (_cmd, opts) => { seen.push(opts?.env?.PATH); return null }
    })
    env.PATH = '/after-login-path'
    await detector.rescan('startup')
    expect(new Set(seen)).toEqual(new Set(['/after-login-path']))
  })

  it('wires the startup trigger behind loginPathReady, unawaited', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    // A statement that starts with `void`: `await loginPathReady.then(…)` in the
    // async ready handler would hold startup, and contains the same text.
    expect(main).toMatch(/^\s*void loginPathReady\.then\(\(\) => toolDetector\.rescan\('startup'\)\)/m)
    expect(main).not.toMatch(/await[^\n]*toolDetector/)
    expect(main.match(/toolDetector\.rescan\('startup'\)/g)).toHaveLength(1)
  })
})

describe('shell reports', () => {
  it('says found, missing or unchecked per executable and per profile', async () => {
    writeReport('a', report({ checked: ['claude', 'vim'], found: { vim: '/usr/bin/vim' } }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => [...PROFILES, profile('only-vi', ['vi'])] })
    const snap = await detector.snapshot()
    const env = snap.environments[0]
    expect(env).toMatchObject({ id: 'shell:linux:kali-linux:zsh', source: 'shell', platform: 'linux', shell: 'zsh', wslDistro: 'kali-linux', sessionId: 's1', detectedAt: 1_000_000 })
    expect(env.profiles.find((p) => p.profile === 'vim')).toEqual({
      profile: 'vim', state: 'found',
      executables: [{ name: 'vim', state: 'found', path: '/usr/bin/vim' }, { name: 'vi', state: 'unchecked' }]
    })
    expect(stateOf(snap, env.id, 'claude-code')).toBe('missing')
    // Added to the profiles after the report was written: not checked, not absent.
    expect(stateOf(snap, env.id, 'codex')).toBe('unchecked')
    expect(stateOf(snap, env.id, 'only-vi')).toBe('unchecked')
  })

  it('marks a report stale after 7 days, and never deletes it', async () => {
    const file = writeReport('a', report({ detectedAt: 1_000_000 }))
    const at = (now: number) => createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES, now: () => now })
    expect((await at(1_000_000 + 7 * DAY).snapshot()).environments[0].stale).toBe(false)
    expect((await at(1_000_000 + 7 * DAY + 1).snapshot()).environments[0].stale).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('ignores a report it cannot trust, and keeps the one it can', async () => {
    writeReport('good', report())
    writeReport('bad-json', '{not json', true)
    writeReport('v2', report({ version: 2, environment: 'shell:v2' }))
    writeReport('foreign-found', report({ environment: 'shell:foreign', found: { rm: '/bin/rm' } }))
    writeReport('path-not-string', report({ environment: 'shell:p1', found: { vim: 7 } }))
    writeReport('path-long', report({ environment: 'shell:p2', found: { vim: '/' + 'a'.repeat(4096) } }))
    writeReport('checked-not-list', report({ environment: 'shell:c1', checked: 'vim' }))
    writeReport('checked-many', report({ environment: 'shell:c2', checked: Array.from({ length: 257 }, (_, i) => `n${i}`), found: {} }))
    writeReport('name-long', report({ environment: 'shell:c3', checked: ['x'.repeat(129)], found: {} }))
    writeReport('no-time', report({ environment: 'shell:t', detectedAt: 'yesterday' }))
    writeReport('not-object', JSON.stringify([report()]), true)
    writeReport('oversize', report({ environment: 'shell:big', sessionId: 'x'.repeat(70_000) }))
    fs.writeFileSync(path.join(reportDir, 'half-written.json.123.part'), JSON.stringify(report({ environment: 'shell:part' })))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    const snap = await detector.snapshot()
    expect(snap.environments.map((e) => e.id)).toEqual(['shell:linux:kali-linux:zsh'])
  })

  it('only takes an environment id that is a shell id and cannot be the app\'s', async () => {
    writeReport('app-id', report({ environment: 'app:linux' }))
    writeReport('empty-tail', report({ environment: 'shell:' }))
    writeReport('space', report({ environment: 'shell:linux:kali linux:zsh' }))
    writeReport('slash', report({ environment: 'shell:linux:a/b:zsh' }))
    writeReport('long', report({ environment: `shell:${'x'.repeat(161)}` }))
    writeReport('ok-max', report({ environment: `shell:${'x'.repeat(160)}` }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({ PATH: '' }), profiles: () => PROFILES })
    const snap = await detector.rescan('manual')
    expect(snap.environments.map((e) => e.id)).toEqual(['app:linux', `shell:${'x'.repeat(160)}`])
    expect(snap.environments.filter((e) => e.source === 'shell')).toHaveLength(1)
  })

  it('rejects a report with no real time on it', async () => {
    writeReport('zero', report({ environment: 'shell:zero', detectedAt: 0 }))
    writeReport('negative', report({ environment: 'shell:negative', detectedAt: -5 }))
    writeReport('one', report({ environment: 'shell:one', detectedAt: 1 }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    expect((await detector.snapshot()).environments.map((e) => e.id)).toEqual(['shell:one'])
  })

  it('calls a report from more than a day in the future stale', async () => {
    const now = 5_000_000_000
    writeReport('soon', report({ environment: 'shell:soon', detectedAt: now + DAY }))
    writeReport('far', report({ environment: 'shell:far', detectedAt: now + DAY + 1 }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES, now: () => now })
    const snap = await detector.snapshot()
    expect(Object.fromEntries(snap.environments.map((e) => [e.id, e.stale]))).toEqual({ 'shell:soon': false, 'shell:far': true })
  })

  it('rejects a report that lists a name twice', async () => {
    writeReport('dup', report({ environment: 'shell:dup', checked: ['vim', 'vi', 'vim'], found: {} }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    expect((await detector.snapshot()).environments).toEqual([])
  })

  it('reads at most 64 reports, the newest by modification time', async () => {
    for (let i = 0; i < 70; i++) {
      const file = writeReport(`r${i}`, report({ environment: `shell:linux:-:e${i}`, detectedAt: i }))
      fs.utimesSync(file, 1_700_000_000 + i, 1_700_000_000 + i)
    }
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    const ids = (await detector.snapshot()).environments.map((e) => e.id)
    expect(ids).toHaveLength(64)
    expect(ids).toContain('shell:linux:-:e69')
    expect(ids).toContain('shell:linux:-:e6')
    expect(ids).not.toContain('shell:linux:-:e5')
  })

  // The directory is writable by anyone who can write ~/.redlog, so what is in
  // it is not trusted to be small, regular or finite. Each of these is a way a
  // file there could cost the app more than reading one report does.
  describe('a directory that cannot be trusted', () => {
    const POSIX = process.platform !== 'win32'
    const detector = () => createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    /** What stat says is no longer what is on disk by the time the file is read:
     *  a lie, to stand in for a swap in the gap between the two. */
    const statSaysSmallFile = (): void => {
      const lie = { isFile: () => true, size: 10, mtimeMs: 1_700_000_000_000 }
      vi.spyOn(fs.promises, 'stat').mockResolvedValue(lie as unknown as fs.Stats)
      vi.spyOn(fs.promises, 'lstat').mockResolvedValue(lie as unknown as fs.Stats)
    }
    afterEach(() => vi.restoreAllMocks())

    it('touches a bounded number of entries however many are there', async () => {
      writeReport('good', report())
      for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(reportDir, `junk${i}.json`), '')
      const stat = vi.spyOn(fs.promises, 'stat')
      const lstat = vi.spyOn(fs.promises, 'lstat')
      const open = vi.spyOn(fs.promises, 'open')
      const readFile = vi.spyOn(fs.promises, 'readFile')
      await detector().snapshot()
      expect(stat.mock.calls.length + lstat.mock.calls.length + open.mock.calls.length + readFile.mock.calls.length).toBeLessThanOrEqual(128)
    }, 120_000)

    it.skipIf(!POSIX)('does not hang on a FIFO, even one stat took for a file (POSIX)', async () => {
      const fifo = path.join(reportDir, 'pipe.json')
      execFileSync('mkfifo', [fifo])
      statSaysSmallFile()
      writeReport('good', report())
      try {
        const snap = await Promise.race([
          detector().snapshot(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot hung on a FIFO')), 3000))
        ])
        expect(snap.environments.map((e) => e.id)).toEqual(['shell:linux:kali-linux:zsh'])
      } finally {
        // A blocked open is a blocked pool thread; a read/write open lets it through.
        try { fs.closeSync(fs.openSync(fifo, 'r+')) } catch { /* nothing was waiting */ }
      }
    }, 15_000)

    it.skipIf(!POSIX)('does not take a report out of a FIFO that has one in it (POSIX)', async () => {
      const fifo = path.join(reportDir, 'pipe.json')
      execFileSync('mkfifo', [fifo])
      // A reader held open keeps what a writer puts in; the writer then goes, so
      // a second reader finds the whole report and then end of file, as it would a file.
      const held = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        const writer = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
        fs.writeSync(writer, JSON.stringify(report({ environment: 'shell:piped' })))
        fs.closeSync(writer)
        expect((await detector().snapshot()).environments).toEqual([])
      } finally { fs.closeSync(held) }
    })

    it('does not read a file that has grown past the cap since it was looked at', async () => {
      fs.writeFileSync(path.join(reportDir, 'big.json'), 'x'.repeat(10 * 1024 * 1024))
      statSaysSmallFile()
      let bytes = 0
      const open = fs.promises.open.bind(fs.promises)
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open(...args)
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>
        ;(handle as unknown as { read: unknown }).read = async (...a: unknown[]) => { const r = await read(...a); bytes += r.bytesRead; return r }
        return handle
      })
      const readFile = fs.promises.readFile.bind(fs.promises)
      vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.promises.readFile>) => {
        const data = await readFile(...args)
        bytes += data.length
        return data
      }) as typeof fs.promises.readFile)
      expect((await detector().snapshot()).environments).toEqual([])
      expect(bytes).toBe(0)
    })

    it.skipIf(!POSIX)('does not follow a symlink (POSIX)', async () => {
      const outside = path.join(home, 'outside.json')
      fs.writeFileSync(outside, JSON.stringify(report({ environment: 'shell:linked' })))
      fs.symlinkSync(outside, path.join(reportDir, 'link.json'))
      writeReport('good', report())
      expect((await detector().snapshot()).environments.map((e) => e.id)).toEqual(['shell:linux:kali-linux:zsh'])
    })
  })

  it('lists the app first, then shells newest first', async () => {
    writeReport('old', report({ environment: 'shell:linux:-:bash', shell: 'bash', detectedAt: 10 }))
    writeReport('new', report({ environment: 'shell:linux:-:zsh', detectedAt: 30 }))
    writeReport('mid', report({ environment: 'shell:darwin:-:zsh', platform: 'darwin', detectedAt: 20 }))
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({ PATH: '' }), profiles: () => PROFILES })
    const snap = await detector.rescan('manual')
    expect(snap.environments.map((e) => e.id)).toEqual(['app:linux', 'shell:linux:-:zsh', 'shell:darwin:-:zsh', 'shell:linux:-:bash'])
  })

  it('picks a report up on the next snapshot, with nothing watching for it', async () => {
    const detector = createToolDetector({ home, platform: 'linux', env: () => ({}), profiles: () => PROFILES })
    expect((await detector.snapshot()).environments).toEqual([])
    writeReport('late', report())
    expect((await detector.snapshot()).environments).toHaveLength(1)
  })
})

describe('triggers and bounds', () => {
  const detectorWith = (h: Harness, extra: Partial<Parameters<typeof createToolDetector>[0]> = {}) =>
    createToolDetector({ home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, lookup: h.lookup, ...extra })
  const NAMES = ['claude', 'codex', 'ssh', 'vi', 'vim']

  it('runs one lookup at a time: two concurrent rescans look each name up once', async () => {
    const h = fakeLookup({ vim: '/usr/bin/vim' }, true)
    const detector = detectorWith(h)
    const first = detector.rescan('manual')
    const second = detector.rescan('manual')
    expect((await detector.snapshot()).scanning).toBe(true)
    h.release()
    const [a, b] = await Promise.all([first, second])
    expect([...h.calls].sort()).toEqual(NAMES)
    expect(a.environments).toEqual(b.environments)
    expect((await detector.snapshot()).scanning).toBe(false)
  })

  it('skips a settings-open rescan within 30 s of a lookup that covered everything, but never a manual one', async () => {
    const h = fakeLookup({})
    let now = 1_000_000
    const detector = detectorWith(h, { now: () => now })
    await detector.rescan('startup')
    expect(h.calls).toHaveLength(NAMES.length)
    now += 10_000
    await detector.rescan('settings-open')
    expect(h.calls).toHaveLength(NAMES.length)
    await detector.rescan('manual')
    expect(h.calls).toHaveLength(NAMES.length * 2)
    now += 30_001
    const snap = await detector.rescan('settings-open')
    expect(h.calls).toHaveLength(NAMES.length * 3)
    expect(snap.lastTrigger).toBe('settings-open')
  })

  it('looks names up one at a time, so one dead PATH entry holds one thread and not all of them', async () => {
    let active = 0
    let most = 0
    const detector = detectorWith(fakeLookup({}), {
      lookup: async () => { active++; most = Math.max(most, active); await new Promise((r) => setTimeout(r, 2)); active--; return null }
    })
    await detector.rescan('manual')
    expect(most).toBe(1)
  })

  it('stops starting lookups once the deadline has passed', async () => {
    const calls: string[] = []
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, scanTimeoutMs: 40,
      lookup: (cmd) => { calls.push(cmd); return new Promise<string | null>(() => {}) }
    })
    const snap = await detector.rescan('manual')
    expect(calls).toEqual(['claude'])
    expect(snap.environments[0].profiles.flatMap((p) => p.executables).every((e) => e.state === 'unchecked')).toBe(true)
  })

  it('does not rescan on every settings-open when the last lookup hit its deadline less than 30 s ago', async () => {
    let now = 1_000_000
    const calls: string[] = []
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, scanTimeoutMs: 30, now: () => now,
      lookup: (cmd) => { calls.push(cmd); return cmd === 'vim' ? new Promise<string | null>(() => {}) : Promise.resolve(null) }
    })
    await detector.rescan('startup')
    const after = calls.length
    now += 10_000
    await detector.rescan('settings-open')
    expect(calls).toHaveLength(after)
    now += 20_001
    await detector.rescan('settings-open')
    expect(calls.length).toBeGreaterThan(after)
  })

  it('counts a name as covered only if it was checked: a lookup that failed is looked up again', async () => {
    let now = 1_000_000
    let fail = true
    const calls: string[] = []
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, now: () => now,
      lookup: async (cmd) => { calls.push(cmd); if (fail && cmd === 'ssh') throw new Error('EIO'); return null }
    })
    const first = await detector.rescan('startup')
    expect(stateOf(first, 'app:linux', 'ssh')).toBe('unchecked')
    fail = false
    const before = calls.length
    now += 5_000
    const second = await detector.rescan('settings-open')
    expect(calls.length - before).toBe(NAMES.length)
    expect(stateOf(second, 'app:linux', 'ssh')).toBe('missing')
  })

  it('does not loop on a profile set that a deadline left partly unchecked', async () => {
    const calls: string[] = []
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, scanTimeoutMs: 30,
      lookup: (cmd) => { calls.push(cmd); return cmd === 'claude' ? new Promise<string | null>(() => {}) : Promise.resolve(null) }
    })
    await detector.rescan('startup')
    const after = calls.length
    await detector.snapshot()
    await detector.snapshot()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toHaveLength(after)
  })

  it('makes a manual rescan wait for the lookup in flight and then run a fresh one, shared by concurrent manuals', async () => {
    const calls: string[] = []
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    let gated = true
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES,
      lookup: async (cmd) => { calls.push(cmd); if (gated) await gate; return null }
    })
    const startup = detector.rescan('startup')
    const a = detector.rescan('manual')
    const b = detector.rescan('manual')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(1) // only the startup lookup's first name: the manuals have not started theirs
    gated = false
    open()
    await Promise.all([startup, a, b])
    expect(calls).toHaveLength(NAMES.length * 2) // the one in flight, then exactly one fresh run for both
    expect((await detector.snapshot()).lastTrigger).toBe('manual')
  })

  it('does not skip a settings-open rescan for executables the last lookup did not cover', async () => {
    const h = fakeLookup({})
    const profiles = [...PROFILES]
    const detector = detectorWith(h, { profiles: () => profiles })
    await detector.rescan('startup')
    profiles.push(profile('nmap', ['nmap']))
    const before = h.calls.length
    await detector.rescan('settings-open')
    expect(h.calls.length - before).toBe(NAMES.length + 1)
  })

  it('leaves a name unchecked when the lookup misses its deadline, and still finishes', async () => {
    const calls: string[] = []
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => PROFILES, scanTimeoutMs: 40,
      lookup: (cmd) => { calls.push(cmd); return cmd === 'vim' ? new Promise<string | null>(() => {}) : Promise.resolve(cmd === 'ssh' ? '/usr/bin/ssh' : null) }
    })
    const started = Date.now()
    const snap = await detector.rescan('manual')
    expect(Date.now() - started).toBeLessThan(2_000)
    const vim = snap.environments[0].profiles.find((p) => p.profile === 'vim')!
    expect(vim.executables.find((e) => e.name === 'vim')!.state).toBe('unchecked')
    expect(vim.executables.find((e) => e.name === 'vi')!.state).toBe('missing')
    expect(stateOf(snap, 'app:linux', 'ssh')).toBe('found')
    expect(snap.scanning).toBe(false)
  })

  it('looks up at most 64 executables', async () => {
    const many = [profile('many', Array.from({ length: 80 }, (_, i) => `tool-${String(i).padStart(2, '0')}`))]
    const h = fakeLookup({})
    const detector = detectorWith(h, { profiles: () => many })
    await detector.rescan('manual')
    expect(h.calls).toHaveLength(64)
  })

  it('looks a changed profile set up once, in the background, from the next snapshot', async () => {
    const h = fakeLookup({}, false)
    const lines: string[] = []
    const profiles = [...PROFILES]
    const detector = detectorWith(h, { profiles: () => profiles, log: (l) => lines.push(l) })
    await detector.rescan('startup')
    expect(lines).toHaveLength(1)

    profiles.push(profile('nmap', ['nmap']))
    const [a, b] = await Promise.all([detector.snapshot(), detector.snapshot()])
    // The snapshot did not wait for it.
    expect(a.lastTrigger === 'startup' || a.lastTrigger === 'profiles-changed').toBe(true)
    expect(b.environments).toHaveLength(1)
    await detector.rescan('manual') // joins or follows it; flushes the queue either way
    const changed = lines.filter((l) => l.includes('trigger=profiles-changed'))
    expect(changed).toHaveLength(1)
    // Settled: another snapshot starts nothing.
    const before = lines.length
    await detector.snapshot()
    await new Promise((r) => setTimeout(r, 20))
    expect(lines).toHaveLength(before)
  })

  it('does not wait for the profiles-changed lookup it starts', async () => {
    let hold = false
    let release = (): void => {}
    const open = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const profiles = [...PROFILES]
    const detector = createToolDetector({
      home, platform: 'linux', env: () => ({ PATH: '/x' }), profiles: () => profiles,
      lookup: async (cmd) => { calls.push(cmd); if (hold) await open; return null }
    })
    await detector.rescan('startup')
    hold = true
    profiles.push(profile('nmap', ['nmap']))
    const snap = await detector.snapshot() // resolves although the lookup it started is hanging
    expect(snap.scanning).toBe(true)
    expect(snap.lastTrigger).toBe('profiles-changed')
    release()
    expect((await detector.rescan('manual')).scanning).toBe(false)
  })

  it('has no profile set to compare against before the first lookup, so a snapshot starts none', async () => {
    const h = fakeLookup({})
    const detector = detectorWith(h)
    const snap = await detector.snapshot()
    expect(snap.scanning).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('writes one debug line per lookup, counting and nothing else', async () => {
    const h = fakeLookup({ vim: '/usr/bin/vim' })
    const lines: string[] = []
    const detector = detectorWith(h, { log: (l) => lines.push(l) })
    await detector.rescan('manual')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^trigger=manual checked=5 found=1 ms=\d+$/)
  })
})

// What main hands tools:rescan is whatever the renderer sent. Only the two
// reasons a person can have trigger a lookup; the others are RedLog's own.
describe('the tools:rescan argument', () => {
  it('lets settings-open and manual through', () => {
    expect(rescanTrigger('settings-open')).toBe('settings-open')
    expect(rescanTrigger('manual')).toBe('manual')
  })

  it('turns everything else into no rescan', () => {
    for (const v of ['startup', 'profiles-changed', '', 'Manual', 'manual ', undefined, null, 0, 1, true, {}, ['manual'], { toString: () => 'manual' }]) {
      expect(rescanTrigger(v), String(JSON.stringify(v))).toBeNull()
    }
  })
})

// "A detection miss must NOT remove or change an effective profile." The
// compiler and the classifier never read a detection result; these are the
// tests that say so, so a later change that makes them cooperate fails here
// and not in an engagement.
describe('a miss never changes what a command is', () => {
  const homes: string[] = []
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  afterEach(() => {
    for (const k of ['HOME', 'USERPROFILE'] as const) { if (savedHome[k] === undefined) delete process.env[k]; else process.env[k] = savedHome[k] }
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  })

  const overlayHome = (file: string | null): string => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tooldet-overlay-'))
    homes.push(h)
    if (file !== null) {
      fs.mkdirSync(path.join(h, '.redlog'))
      fs.writeFileSync(path.join(h, '.redlog', 'command-class.json'), file)
    }
    return h
  }
  const modeFor = (lists: { native: string[]; pty: string[] }, program: string): string =>
    lists.pty.includes(program) ? 'pty' : lists.native.includes(program) ? 'native' : shipped.repl.includes(program) ? 'native' : 'relayed'

  // Every executable a shipped profile names, reported missing from the
  // process's own PATH and from a shell, with the report where a reader that
  // went looking under HOME would find it.
  const allMissing = async (): Promise<ToolDetectionSnapshot> => {
    const names = [...new Set(knownProfiles().flatMap((p) => p.executables))].sort()
    writeReport('all-missing', report({ checked: names, found: {} }))
    process.env.HOME = home
    process.env.USERPROFILE = home
    const detector = createToolDetector({ home, platform: process.platform, env: () => ({ PATH: '' }), profiles: () => knownProfiles() })
    return detector.rescan('manual')
  }

  for (const c of golden.cases) {
    it(`${c.id}: ${c.name} still compiles to the golden modes with everything reported missing`, async () => {
      const snap = await allMissing()
      expect(snap.environments.flatMap((e) => e.profiles.map((p) => p.state))).not.toContain('found')
      const lists = compileClassPolicy(readClassOverlay(overlayHome(c.file)))
      const modes = Object.fromEntries(golden.probes.map((p) => [p, modeFor(lists, p)]))
      expect(modes).toEqual(c.modes)
    })
  }

  it('classifies every shipped profile executable as its profile says, with everything reported missing', async () => {
    await allMissing()
    for (const p of knownProfiles()) {
      for (const exe of p.executables) expect(classifyCommand([exe]), `${p.id}: ${exe}`).toBe(p.mode)
    }
  })

  it('looks for a plugin\'s tool too: the profiles it joins to are the ones the compiler uses', async () => {
    const plugin = { id: 'acme/scanner', name: 'Acme scanner', mode: 'pty', executables: ['acme-scan'], reason: 'test' }
    const bad = { id: 'Not Valid', name: 'x', mode: 'pty', executables: ['y'], reason: 'test' }
    const snapshot = { version: 1, profiles: [plugin, bad], held: {} }
    const known = knownProfiles(undefined, snapshot)
    expect(known.map((p) => p.id)).toContain('acme/scanner')
    expect(known.map((p) => p.id)).not.toContain('Not Valid')
    // The compiler credits a command to exactly the profiles detection joins to.
    const compiled = compileClassPolicy(null, undefined, snapshot)
    const credited = new Set(compiled.entries.filter((e) => e.source === 'profile').map((e) => e.profile))
    for (const id of credited) expect(known.map((p) => p.id), String(id)).toContain(id)
    expect(compiled.problems.filter((p) => p.kind === 'invalid-profile')).toHaveLength(1)
    // And detection reports it.
    const detector = createToolDetector({ home, platform: process.platform, env: () => ({ PATH: '' }), profiles: () => known })
    const snap = await detector.rescan('manual')
    expect(snap.environments.flatMap((e) => e.profiles.map((p) => p.profile))).toContain('acme/scanner')
  })

  it('carries no mode in a snapshot', async () => {
    const snap = await allMissing()
    expect(JSON.stringify(snap)).not.toMatch(/"mode"/)
  })

  it('is not referenced by the compiler or the enrollment logic', () => {
    for (const file of ['src/core/terminal-class.ts', 'src/core/terminal-enrollment.ts']) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      expect(text, file).not.toMatch(/tool-detection|toolDetect|tool_detect/)
    }
  })

  it('is named by exactly one function of the relay: classify, finish, pty, policy and state never read a report', () => {
    const relay = fs.readFileSync(path.join(__dirname, '..', 'hooks/redlog-relay.py'), 'utf8')
    // Every top-level def is a chunk of its own, the module header and any
    // top-level code before the first def is chunk 0, and a def added later
    // anywhere in the file is checked too.
    const ALLOWED = new Set(['detect_cmd'])
    const chunks = relay.split(/^(?=def \w)/m)
    const named: string[] = []
    for (const chunk of chunks) {
      if (!/tool-detection/.test(chunk)) continue
      named.push(/^def (\w+)/.exec(chunk)?.[1] ?? '<module level>')
    }
    expect(named.filter((n) => !ALLOWED.has(n)), 'functions other than the detect code name the report directory').toEqual([])
    expect(named).toEqual(['detect_cmd'])
  })

  it('keeps hooks:terminalPolicy free of detection', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    const start = main.indexOf("ipcMain.handle('hooks:terminalPolicy'")
    expect(start).toBeGreaterThan(-1)
    // To the handler's own closing line, whether it returns an object literal or a block.
    const handler = main.slice(start, main.indexOf('\n  })', start) + 5)
    expect(handler).toContain('compileClassPolicy')
    expect(handler).not.toMatch(/toolDetector|tool-detection|tools:/)
  })
})
