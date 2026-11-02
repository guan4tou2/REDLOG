import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { replaySpoolDirectory, type SpoolReplayEvent } from '../src/core/spool-replay'

const dirs: string[] = []
const dir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function write(d: string, name: string, engagementId?: string): string {
  const file = path.join(d, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify({
    agent_type: 'shell', data: { command: name },
    ...(engagementId ? { _identity: { engagementId, operatorId: 'op-a' } } : {})
  }))
  return file
}

describe('spool replay isolation', () => {
  it('defers a mismatched engagement without changing or moving its file', () => {
    const d = dir(); const file = write(d, 'secret-a', 'project-a'); const before = fs.readFileSync(file)
    const emitted: SpoolReplayEvent[] = []
    expect(replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => { emitted.push(e); return true }))
      .toEqual({ replayed: 0, deferred: 1, unattributed: 0, invalid: 0, last: 'secret-a.json' })
    expect(emitted).toEqual([])
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('replays and removes the deferred file when its project becomes active', () => {
    const d = dir(); const file = write(d, 'secret-a', 'project-a'); const emitted: SpoolReplayEvent[] = []
    replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => { emitted.push(e); return true })
    expect(replaySpoolDirectory(d, { engagementId: 'project-a', operatorId: 'op-new' }, e => { emitted.push(e); return true }))
      .toEqual({ replayed: 1, deferred: 0, unattributed: 0, invalid: 0, last: 'secret-a.json' })
    expect(emitted[0]).toMatchObject({ engagementId: 'project-a', operatorId: 'op-a', data: { command: 'secret-a', recovered_from_spool: true } })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('quarantines an unattributed pre-release payload instead of assigning the active project', () => {
    const d = dir(); const file = write(d, 'unknown')
    const emitted: SpoolReplayEvent[] = []
    expect(replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => { emitted.push(e); return true }))
      .toEqual({ replayed: 0, deferred: 0, unattributed: 1, invalid: 0, last: 'unknown.json' })
    expect(emitted).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.unattributed`)).toBe(true)
  })

  it('keeps an attributable item pending until the write is accepted', () => {
    const d = dir(); const file = write(d, 'during-pause', 'project-a')
    expect(replaySpoolDirectory(d, { engagementId: 'project-a', operatorId: 'op-a' }, () => false))
      .toEqual({ replayed: 0, deferred: 1, unattributed: 0, invalid: 0, last: 'during-pause.json' })
    expect(fs.existsSync(file)).toBe(true)
  })
})

// A drain that runs in slices resumes where the last one stopped. `after` is
// that place, and `last` is what the caller hands back for it — including files
// that were looked at and left alone, or another project's files would pin the
// cursor behind them.
describe('resuming a replay after a name', () => {
  const ACTIVE = { engagementId: 'project-a', operatorId: 'op-a' }
  const names = (emitted: SpoolReplayEvent[]): unknown[] => emitted.map((e) => e.data.command)

  it('continues in sorted order from the cursor and reports the last name it looked at', () => {
    const d = dir()
    for (const n of ['e', 'c', 'a', 'd', 'b']) write(d, n, 'project-a')
    const emitted: SpoolReplayEvent[] = []
    const emit = (e: SpoolReplayEvent): boolean => { emitted.push(e); return true }

    const first = replaySpoolDirectory(d, ACTIVE, emit, 2)
    expect(first.last).toBe('b.json')
    const second = replaySpoolDirectory(d, ACTIVE, emit, 2, first.last!)
    expect(second.last).toBe('d.json')
    const third = replaySpoolDirectory(d, ACTIVE, emit, 2, second.last!)
    expect(third.last).toBe('e.json')
    expect(names(emitted)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(replaySpoolDirectory(d, ACTIVE, emit, 2, third.last!).last).toBeNull()
  })

  it('names nothing when there is nothing to look at', () => {
    expect(replaySpoolDirectory(dir(), ACTIVE, () => true).last).toBeNull()
    expect(replaySpoolDirectory(path.join(dir(), 'missing'), ACTIVE, () => true).last).toBeNull()
  })

  it('counts a deferred, unattributed or unreadable file as looked at', () => {
    const d = dir()
    write(d, 'a-other', 'project-b')
    write(d, 'b-nobody')
    fs.writeFileSync(path.join(d, 'c-garbage.json'), '{')
    write(d, 'd-mine', 'project-a')
    const emitted: SpoolReplayEvent[] = []
    const emit = (e: SpoolReplayEvent): boolean => { emitted.push(e); return true }

    // The three that cannot be replayed fill the slice; the cursor still moves.
    const first = replaySpoolDirectory(d, ACTIVE, emit, 3)
    expect(first).toMatchObject({ replayed: 0, deferred: 1, unattributed: 1, invalid: 1, last: 'c-garbage.json' })
    const second = replaySpoolDirectory(d, ACTIVE, emit, 3, first.last!)
    expect(second).toMatchObject({ replayed: 1, last: 'd-mine.json' })
    expect(names(emitted)).toEqual(['d-mine'])
  })

  it('leaves files at or before the cursor alone', () => {
    const d = dir()
    write(d, 'a', 'project-a'); write(d, 'b', 'project-a')
    const emitted: SpoolReplayEvent[] = []
    replaySpoolDirectory(d, ACTIVE, (e) => { emitted.push(e); return true }, Number.POSITIVE_INFINITY, 'a.json')
    expect(names(emitted)).toEqual(['b'])
    expect(fs.existsSync(path.join(d, 'a.json'))).toBe(true)
  })
})

// What the drain does with an event it will not store.
//
// `emit` returning false means "could not write, keep the file", and the
// drain retries the directory every 30 seconds. Once the drain went through
// ingest(), two of its outcomes produce no row on purpose — RedLog's own
// shell plumbing, and the 2s dedup window — so treating those as failures
// would leave the file on disk being retried forever.
describe('a spooled event the pipeline declines', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-drop-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const write = (name: string, command: string): void => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
      agent_type: 'shell',
      data: { subtype: 'command_start', command },
      _identity: { engagementId: 'eng', operatorId: 'op' }
    }))
  }

  it('consumes the file when emit reports the event handled', () => {
    write('1.json', 'whoami')
    const r = replaySpoolDirectory(dir, { engagementId: 'eng', operatorId: 'op' }, () => true)
    expect(r.replayed).toBe(1)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('keeps the file when emit reports it could not be written', () => {
    write('1.json', 'whoami')
    const r = replaySpoolDirectory(dir, { engagementId: 'eng', operatorId: 'op' }, () => false)
    expect(r.deferred).toBe(1)
    expect(fs.readdirSync(dir)).toEqual(['1.json'])
  })
})
