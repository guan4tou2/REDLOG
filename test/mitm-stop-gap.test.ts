import { it, expect, describe, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reapInflightMarkers } from '../src/core/inflight-marker'
import { queueGapAgainstPauses } from '../src/core/queue-gap'
import { replaySpoolDirectory } from '../src/core/spool-replay'

// #291: what the proxy had admitted and not delivered when it stopped.
it('records a stop as exact and unconfirmed gaps, and keeps a bound on disk while events are in flight', () => {
  const result = spawnSync('python3', ['test/fixtures/mitm-stop-gap-check.py'], { encoding: 'utf8', timeout: 20000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('stop gap checks passed')
})

const A = { engagementId: 'A', operatorId: 'op-A' }

function marker(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, instance: '4242-1', pid: 4242, started_at: 1_000, heartbeat_at: 50_000,
    identities: [{ identity: A, upper_bound: 16, since: 10_000, last: 40_000 }],
    ...over
  }
}

describe('a killed proxy\'s in-flight marker', () => {
  function setup(): { root: string; inflight: string; spool: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-inflight-'))
    const inflight = path.join(root, 'inflight')
    fs.mkdirSync(inflight)
    return { root, inflight, spool: path.join(root, 'pending') }
  }

  it('becomes an up-to-N gap for its project once the producer is gone, and the marker is removed', () => {
    const { root, inflight, spool } = setup()
    try {
      fs.writeFileSync(path.join(inflight, '4242-1.json'), JSON.stringify(marker()))
      expect(reapInflightMarkers(inflight, spool, 60_000, () => false)).toBe(1)
      expect(fs.readdirSync(inflight)).toEqual([])
      const replayed: Array<Record<string, unknown>> = []
      const deferred = replaySpoolDirectory(spool, { engagementId: 'B', operatorId: 'op-B' }, () => true)
      expect(deferred.replayed).toBe(0)
      replaySpoolDirectory(spool, A, (e) => { expect(e.engagementId).toBe('A'); replayed.push(e.data); return true })
      expect(replayed).toHaveLength(1)
      expect(replayed[0]).toMatchObject({
        subtype: 'capture_gap', source: 'mitmproxy', reason: 'delivery-interrupted', capture_delivery: 'unknown',
        skipped_units: 16, gap_started_at: 10_000, gap_ended_at: 50_000
      })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('is left alone while its producer is alive and beating, and reaped once the heartbeat is long stale', () => {
    const { root, inflight, spool } = setup()
    try {
      fs.writeFileSync(path.join(inflight, '4242-1.json'), JSON.stringify(marker()))
      expect(reapInflightMarkers(inflight, spool, 60_000, () => true)).toBe(0)
      expect(fs.readdirSync(inflight)).toEqual(['4242-1.json'])
      expect(fs.existsSync(spool)).toBe(false)
      // A live pid with a heartbeat ten minutes old is a reused pid, not the proxy.
      expect(reapInflightMarkers(inflight, spool, 50_000 + 10 * 60_000 + 1, () => true)).toBe(1)
      expect(fs.readdirSync(spool)).toHaveLength(1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  // A marker that cannot be removed (a directory a root-run producer created)
  // must not be reaped again every drain: a replayed record would come back.
  it('is reaped once even when it cannot be removed, and not at all when it cannot be claimed', () => {
    const { root, inflight, spool } = setup()
    const rename = vi.spyOn(fs, 'renameSync')
    const unlink = vi.spyOn(fs, 'unlinkSync')
    try {
      fs.writeFileSync(path.join(inflight, '4242-1.json'), JSON.stringify(marker()))
      rename.mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
      expect(reapInflightMarkers(inflight, spool, 60_000, () => false)).toBe(0)
      expect(fs.existsSync(spool) ? fs.readdirSync(spool) : []).toEqual([])
      unlink.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
      expect(reapInflightMarkers(inflight, spool, 60_000, () => false)).toBe(1)
      for (const file of fs.readdirSync(spool)) fs.rmSync(path.join(spool, file))
      expect(reapInflightMarkers(inflight, spool, 90_000, () => false)).toBe(0)
      expect(fs.readdirSync(spool)).toEqual([])
    } finally {
      rename.mockRestore()
      unlink.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes nothing for an empty bound or an unowned entry, and sets aside a marker it cannot read', () => {
    const { root, inflight, spool } = setup()
    try {
      fs.writeFileSync(path.join(inflight, 'a.json'), JSON.stringify(marker({
        identities: [{ identity: A, upper_bound: 0, since: 1, last: 2 }, { identity: { engagementId: 'A' }, upper_bound: 8, since: 1, last: 2 }]
      })))
      fs.writeFileSync(path.join(inflight, 'b.json'), '{not json')
      fs.writeFileSync(path.join(inflight, 'c.json.tmp'), '{}')
      reapInflightMarkers(inflight, spool, 60_000, () => false)
      expect(fs.existsSync(spool) ? fs.readdirSync(spool) : []).toEqual([])
      expect(fs.readdirSync(inflight).sort()).toEqual(['b.json.bad', 'c.json.tmp'])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('a stop gap against the recording pauses', () => {
  const pauses: Array<[number, number]> = [[100, 200]]
  it.each(['proxy-stopped', 'delivery-interrupted'])('%s inside a pause is no loss; across a boundary it says so', (reason) => {
    const gap = { subtype: 'capture_gap', reason, gap_started_at: 120, gap_ended_at: 180, skipped_units: 3 }
    expect(queueGapAgainstPauses(gap, pauses)).toBeNull()
    expect(queueGapAgainstPauses({ ...gap, gap_ended_at: 250 }, pauses)).toMatchObject({ overlaps_pause: true })
    expect(queueGapAgainstPauses({ ...gap, gap_started_at: 300, gap_ended_at: 310 }, pauses)).toEqual({ ...gap, gap_started_at: 300, gap_ended_at: 310 })
  })
})
