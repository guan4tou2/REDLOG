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
      .toEqual({ replayed: 0, deferred: 1, unattributed: 0, invalid: 0 })
    expect(emitted).toEqual([])
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('replays and removes the deferred file when its project becomes active', () => {
    const d = dir(); const file = write(d, 'secret-a', 'project-a'); const emitted: SpoolReplayEvent[] = []
    replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => { emitted.push(e); return true })
    expect(replaySpoolDirectory(d, { engagementId: 'project-a', operatorId: 'op-new' }, e => { emitted.push(e); return true }))
      .toEqual({ replayed: 1, deferred: 0, unattributed: 0, invalid: 0 })
    expect(emitted[0]).toMatchObject({ engagementId: 'project-a', operatorId: 'op-a', data: { command: 'secret-a', recovered_from_spool: true } })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('quarantines an unattributed pre-release payload instead of assigning the active project', () => {
    const d = dir(); const file = write(d, 'unknown')
    const emitted: SpoolReplayEvent[] = []
    expect(replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => { emitted.push(e); return true }))
      .toEqual({ replayed: 0, deferred: 0, unattributed: 1, invalid: 0 })
    expect(emitted).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.unattributed`)).toBe(true)
  })

  it('keeps an attributable item pending until the write is accepted', () => {
    const d = dir(); const file = write(d, 'during-pause', 'project-a')
    expect(replaySpoolDirectory(d, { engagementId: 'project-a', operatorId: 'op-a' }, () => false))
      .toEqual({ replayed: 0, deferred: 1, unattributed: 0, invalid: 0 })
    expect(fs.existsSync(file)).toBe(true)
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
