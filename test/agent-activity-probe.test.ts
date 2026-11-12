import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  createActivityProbe, findRecentActivity, PROBE_BOUND, PROBE_FUTURE_TOLERANCE_MS, type ProbeFs
} from '../src/core/agent-activity-probe'

// Temp directories only. Nothing here may touch the real ~/.claude or ~/.codex.

const WINDOW = 10 * 60 * 1000
const NOW = Date.now()

function counting(): ProbeFs & { calls: number } {
  const c = {
    calls: 0,
    stat: (p: string) => { c.calls++; return fsp.stat(p) },
    lstat: (p: string) => { c.calls++; return fsp.lstat(p) },
    readdir: (p: string, o: { withFileTypes: true }) => { c.calls++; return fsp.readdir(p, o) }
  }
  return c
}

function file(p: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-probe-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('findRecentActivity', () => {
  it('no directory: nothing', async () => {
    expect(await findRecentActivity(path.join(tmp, 'absent'), NOW, { windowMs: WINDOW })).toBeNull()
  })

  it('a directory left by an old install: nothing', async () => {
    file(path.join(tmp, 'root', 'proj', 'old.jsonl'), NOW - 3 * 24 * 3600_000)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeNull()
  })

  it('a file written within the window: detected (Codex layout, depth 4)', async () => {
    const at = NOW - 60_000
    file(path.join(tmp, 'root', '2026', '11', '12', 'rollout-x.jsonl'), at)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeCloseTo(at, -1)
  })

  it('a modification time in the future is not "now", however far ahead', async () => {
    file(path.join(tmp, 'root', 'p', 'a.jsonl'), NOW + 24 * 3600_000)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeNull()
    // …but ordinary skew inside the tolerance still counts.
    const near = NOW + PROBE_FUTURE_TOLERANCE_MS / 2
    file(path.join(tmp, 'root', 'p', 'b.jsonl'), near)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeCloseTo(near, -1)
  })

  it('stops at the bound on a directory with many entries', async () => {
    const root = path.join(tmp, 'root')
    for (let i = 0; i < 1000; i++) file(path.join(root, 'proj', `s${String(i).padStart(4, '0')}.jsonl`), NOW - 3600_000)
    const f = counting()
    expect(await findRecentActivity(root, NOW, { windowMs: WINDOW, fs: f })).toBeNull()
    expect(f.calls).toBe(PROBE_BOUND.maxCalls)
  })

  it('stops at the time budget', async () => {
    const root = path.join(tmp, 'root')
    for (let i = 0; i < 50; i++) file(path.join(root, `s${i}.jsonl`), NOW - 3600_000)
    let t = 0
    const f = counting()
    await findRecentActivity(root, NOW, { windowMs: WINDOW, fs: f, clock: () => (t += 100), bound: { ...PROBE_BOUND, budgetMs: 500 } })
    expect(f.calls).toBeLessThan(10)
  })

  it('does not follow a symlink out of the root', async () => {
    const outside = path.join(tmp, 'outside')
    file(path.join(outside, 'fresh.jsonl'), NOW - 1000)
    fs.mkdirSync(path.join(tmp, 'root'))
    fs.symlinkSync(outside, path.join(tmp, 'root', 'link'), 'dir')
    fs.symlinkSync(path.join(outside, 'fresh.jsonl'), path.join(tmp, 'root', 'file-link.jsonl'))
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeNull()
  })

  it('does not count the open project directory under the root', async () => {
    const project = path.join(tmp, 'root', 'engagement')
    file(path.join(project, 'agent-transcripts', 'sidecar.jsonl'), NOW - 1000)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW, exclude: [project] })).toBeNull()
  })

  it('does not descend past the depth bound', async () => {
    file(path.join(tmp, 'root', 'a', 'b', 'c', 'd', 'deep.jsonl'), NOW - 1000)
    expect(await findRecentActivity(path.join(tmp, 'root'), NOW, { windowMs: WINDOW })).toBeNull()
  })

  it('measures: a 2,000-entry tree with nothing fresh', async () => {
    const root = path.join(tmp, 'root')
    for (let p = 0; p < 20; p++) for (let s = 0; s < 100; s++) file(path.join(root, `p${p}`, `s${s}.jsonl`), NOW - 3600_000)
    const f = counting()
    const t0 = performance.now()
    await findRecentActivity(root, NOW, { windowMs: WINDOW, fs: f })
    const ms = performance.now() - t0
    console.log(`[probe] 2000 entries, nothing fresh: ${f.calls} fs calls, ${ms.toFixed(1)} ms wall`)
    expect(f.calls).toBeLessThanOrEqual(PROBE_BOUND.maxCalls)
  })
})

describe('createActivityProbe', () => {
  it('a second read within the interval performs no fs walk', async () => {
    file(path.join(tmp, 'root', 'p', 'a.jsonl'), NOW - 1000)
    const f = counting()
    let changed = 0
    const probe = createActivityProbe({ windowMs: WINDOW, fs: f, onChange: () => { changed++ } })
    // First read starts the walk and has no answer yet.
    expect(probe.recentActivity(path.join(tmp, 'root'), NOW)).toBeNull()
    await probe.settle()
    expect(changed).toBe(1)
    const after = f.calls
    expect(probe.recentActivity(path.join(tmp, 'root'), NOW + 1000)).not.toBeNull()
    expect(probe.recentActivity(path.join(tmp, 'root'), NOW + 59_000)).not.toBeNull()
    await probe.settle()
    expect(f.calls).toBe(after)
    // Past the interval, one more walk.
    probe.recentActivity(path.join(tmp, 'root'), NOW + 61_000)
    await probe.settle()
    expect(f.calls).toBeGreaterThan(after)
  })

  it('an answer does not outlive its walk by more than a window', async () => {
    file(path.join(tmp, 'root', 'p', 'a.jsonl'), NOW - 1000)
    let clock = NOW
    const probe = createActivityProbe({ windowMs: WINDOW, clock: () => clock, recheckMs: Number.MAX_SAFE_INTEGER })
    probe.recentActivity(path.join(tmp, 'root'), NOW)
    await probe.settle()
    expect(probe.recentActivity(path.join(tmp, 'root'), NOW + 1000)).not.toBeNull()
    clock = NOW + WINDOW + 1
    expect(probe.recentActivity(path.join(tmp, 'root'), NOW + WINDOW + 1001)).toBeNull()
  })
})

// The one promise this feature makes about privacy: it looks at names and
// timestamps, never at what a tool wrote. A later edit that starts reading
// transcripts has to break this first.
describe('agent-activity-probe source', () => {
  it('contains no file-content read', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'agent-activity-probe.ts'), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(src).not.toMatch(/\b(readFile|readFileSync|createReadStream|openSync|readSync|readv|readlink|opendir)\b/)
    expect(src).not.toMatch(/\.open\s*\(/)
    expect(src).not.toMatch(/\bopen\s*\(/)
    expect(src).not.toMatch(/require\(|import\(/)
  })
})
