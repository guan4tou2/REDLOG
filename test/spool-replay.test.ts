import { afterEach, describe, expect, it } from 'vitest'
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
    expect(replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => emitted.push(e)))
      .toEqual({ replayed: 0, deferred: 1, invalid: 0 })
    expect(emitted).toEqual([])
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it('replays and removes the deferred file when its project becomes active', () => {
    const d = dir(); const file = write(d, 'secret-a', 'project-a'); const emitted: SpoolReplayEvent[] = []
    replaySpoolDirectory(d, { engagementId: 'project-b', operatorId: 'op-b' }, e => emitted.push(e))
    expect(replaySpoolDirectory(d, { engagementId: 'project-a', operatorId: 'op-new' }, e => emitted.push(e)))
      .toEqual({ replayed: 1, deferred: 0, invalid: 0 })
    expect(emitted[0]).toMatchObject({ engagementId: 'project-a', operatorId: 'op-a', data: { command: 'secret-a', recovered_from_spool: true } })
    expect(fs.existsSync(file)).toBe(false)
  })
})
