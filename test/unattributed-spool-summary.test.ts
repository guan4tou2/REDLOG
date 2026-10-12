import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { replaySpoolDirectory, summarizeUnattributedSpool } from '../src/core/spool-replay'

// #255. Commands typed while no project was open reach the spool without an
// engagement identity, replay renames them `.unattributed`, and nothing said so.
// The summary reads what is on disk, so it answers the same way a minute or a
// week after the rename.

describe('summarizeUnattributedSpool', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, body: unknown, mtime?: number): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
    if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000)
    return file
  }
  const payload = (over: Record<string, unknown> = {}) =>
    ({ agent_type: 'shell', data: { subtype: 'command_start', command: 'id' }, ...over })

  it('is null for a directory that does not exist and for one with nothing set aside', () => {
    expect(summarizeUnattributedSpool(path.join(dir, 'missing'))).toBeNull()
    expect(summarizeUnattributedSpool(dir)).toBeNull()
    write('1.json', payload())            // waiting for replay — not set aside yet
    write('2.json.bad', 'not json')       // a different outcome
    expect(summarizeUnattributedSpool(dir)).toBeNull()
  })

  it('counts only the .unattributed files and spans their write times', () => {
    write('a.json.unattributed', payload(), Date.UTC(2026, 9, 12, 2, 0, 0))
    write('b.json.unattributed', payload(), Date.UTC(2026, 9, 12, 9, 30, 0))
    write('c.json.unattributed', payload(), Date.UTC(2026, 9, 12, 5, 0, 0))
    write('d.json', payload())
    write('e.json.bad', 'x')
    expect(summarizeUnattributedSpool(dir)).toEqual({
      count: 3,
      oldestAt: Date.UTC(2026, 9, 12, 2, 0, 0),
      newestAt: Date.UTC(2026, 9, 12, 9, 30, 0)
    })
  })

  it('reads the files replay itself set aside, and keeps answering after the run', () => {
    // The loop closed end to end: a payload with no identity goes through the
    // real replay, and the summary finds it — with the time the file was
    // written, which the rename does not change.
    const t = Date.UTC(2026, 9, 11, 23, 15, 0)
    write('1.json', payload(), t)
    write('2.json', payload({ _identity: { engagementId: 'e1', operatorId: 'op' } }), t)
    const emitted: unknown[] = []
    const run = replaySpoolDirectory(dir, { engagementId: 'e1', operatorId: 'op' }, (ev) => { emitted.push(ev); return true })
    expect(run).toMatchObject({ replayed: 1, unattributed: 1 })
    expect(summarizeUnattributedSpool(dir)).toEqual({ count: 1, oldestAt: t, newestAt: t })
    // A second replay has nothing new to rename, and the answer is unchanged.
    replaySpoolDirectory(dir, { engagementId: 'e1', operatorId: 'op' }, () => true)
    expect(summarizeUnattributedSpool(dir)).toEqual({ count: 1, oldestAt: t, newestAt: t })
  })
})
