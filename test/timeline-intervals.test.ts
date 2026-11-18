import { describe, expect, it } from 'vitest'
import type { RedLogEvent } from '../src/core/db/event-types'
import { rowTerminal } from '../src/core/ingest/terminal'
import { operationPairKey } from '../src/core/operation-pair-key'
import { collapseCommandPairs, unfinishedCommandIds } from '../src/renderer/src/lib/timelineEvents'
import {
  buildCommandIntervals, nextTrackOrder, terminalTrackKey, type TimelineIntervalSet, type TimelineTrack
} from '../src/renderer/src/lib/timelineIntervals'

// Spec 078: a terminal's commands as intervals. The pairing is the Timeline's
// fold (collapseCommandPairs / unfinishedCommandIds on operationPairKey), not a
// second rule: a start the fold hides is exactly a start an interval claims.

const T0 = 1_700_000_000_000

type Extra = Record<string, unknown>
function sh(id: string, ts: number, subtype: string, data: Extra = {}, top: Extra = {}): RedLogEvent {
  return {
    id, timestamp: ts, agentType: 'shell', engagementId: 'eng', sessionId: 's', createdAt: ts, operatorId: 'op', hostname: 'h',
    data: { subtype, shell: 'zsh', pid: 4821, terminalId: 't1', ...data },
    ...top
  } as unknown as RedLogEvent
}
const start = (id: string, ts: number, cid: string, command: string, data: Extra = {}): RedLogEvent =>
  sh(id, ts, 'command_start', { command_id: cid, command, ...data })
const end = (id: string, ts: number, cid: string, command: string, data: Extra = {}): RedLogEvent =>
  sh(id, ts, 'command_end', { command_id: cid, command, exit_code: 0, duration_sec: 1, ...data })

describe('buildCommandIntervals: pairing', () => {
  it('pairs a start and its end into one interval, timed by the two rows', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'nmap -sV 10.0.0.5'),
      end('e1', T0 + 42_000, 'c1', 'nmap -sV 10.0.0.5', { duration_sec: 42 })
    ])
    expect(set.intervals).toHaveLength(1)
    expect(set.intervals[0]).toEqual({
      id: `command:${operationPairKey(start('s1', T0, 'c1', 'x'))}`,
      kind: 'command',
      trackKey: 'terminal:t1',
      startId: 's1', startTs: T0,
      endId: 'e1', endTs: T0 + 42_000,
      endBasis: 'observed',
      supersededById: null,
      anchorId: 'e1',
      memberIds: ['s1', 'e1'],
      command: 'nmap -sV 10.0.0.5',
      exitCode: 0,
      reportedDurationSec: 42,
      reversed: false
    })
    expect([...set.claimed].sort()).toEqual(['e1', 's1'])
    expect(set.byMemberId.get('s1')).toBe(set.intervals[0])
    expect(set.byMemberId.get('e1')).toBe(set.intervals[0])
    expect(set.tracks).toEqual([{
      key: 'terminal:t1', terminalId: 't1', shell: 'zsh', pid: 4821, builtin: false,
      firstTs: T0, lastTs: T0 + 42_000, intervalCount: 1
    }])
  })

  it('an end whose start is not loaded: the start is unknown, never the loaded edge', () => {
    const set = buildCommandIntervals([end('e1', T0, 'c1', 'id', { exit_code: 1, duration_sec: 7 })])
    expect(set.intervals[0]).toMatchObject({
      startId: null, startTs: null, endId: 'e1', endTs: T0, endBasis: 'observed', anchorId: 'e1',
      memberIds: ['e1'], command: 'id', exitCode: 1, reportedDurationSec: 7, reversed: false
    })
  })

  it('a start with no end is open: no end time, anchored on the start', () => {
    const set = buildCommandIntervals([start('s1', T0, 'c1', 'nc -lvnp 4444')])
    expect(set.intervals[0]).toMatchObject({
      startId: 's1', startTs: T0, endId: null, endTs: null, endBasis: 'open', supersededById: null,
      anchorId: 's1', memberIds: ['s1'], exitCode: null, reportedDurationSec: null
    })
  })

  it('two different ends for one key draw no interval: every row stays a dot', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'whoami'),
      end('e1', T0 + 1000, 'c1', 'whoami', { exit_code: 0 }),
      end('e2', T0 + 2000, 'c1', 'whoami', { exit_code: 1 })
    ])
    expect(set.intervals).toEqual([])
    expect(set.claimed.size).toBe(0)
    expect(set.tracks).toEqual([])
  })

  it('two identical ends are one end: the earlier is the end, both are members', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'whoami'),
      end('e2', T0 + 2000, 'c1', 'whoami'),
      end('e1', T0 + 1000, 'c1', 'whoami')
    ])
    expect(set.intervals[0]).toMatchObject({ endId: 'e1', endTs: T0 + 1000, memberIds: ['s1', 'e1', 'e2'] })
  })

  it('a start whose command text differs from its end is not paired, as the fold does not fold it', () => {
    const rows = [start('s1', T0, 'c1', 'nmap'), end('e1', T0 + 1000, 'c1', 'nmap -sV')]
    expect(collapseCommandPairs(rows).map((e) => e.id)).toEqual(['s1', 'e1'])
    expect(buildCommandIntervals(rows).intervals).toEqual([])
  })

  it('duplicate starts: the earliest is the start, the rest are members', () => {
    const set = buildCommandIntervals([
      start('s2', T0 + 500, 'c1', 'ls'),
      start('s1', T0, 'c1', 'ls'),
      end('e1', T0 + 1000, 'c1', 'ls')
    ])
    expect(set.intervals).toHaveLength(1)
    expect(set.intervals[0]).toMatchObject({ startId: 's1', startTs: T0, memberIds: ['s1', 's2', 'e1'] })
  })

  it('rows with no pair key are not intervals (PID and text never stand in for it)', () => {
    const set = buildCommandIntervals([
      sh('s1', T0, 'command_start', { command: 'ls' }),
      sh('e1', T0 + 1, 'command_end', { command: 'ls', exit_code: 0 }),
      start('s2', T0, 'c2', 'ls', { terminalId: undefined }),
      { ...start('s3', T0, 'c3', 'ls'), sessionId: '' } as RedLogEvent
    ])
    expect(set.intervals).toEqual([])
  })

  it('a non-numeric exit code is no exit code', () => {
    const set = buildCommandIntervals([start('s1', T0, 'c1', 'x'), end('e1', T0 + 1, 'c1', 'x', { exit_code: '1' })])
    expect(set.intervals[0].exitCode).toBeNull()
  })

  it('takes the command from the start, and from the end when no start is loaded', () => {
    expect(buildCommandIntervals([start('s1', T0, 'c1', 'a')]).intervals[0].command).toBe('a')
    expect(buildCommandIntervals([end('e1', T0, 'c1', 'b')]).intervals[0].command).toBe('b')
  })
})

describe('buildCommandIntervals: what ends a command that was never seen to end', () => {
  it('a command_boundary naming the start in _causes supersedes it', () => {
    const boundary = sh('b1', T0 + 9000, 'command_boundary', { command_id: 'c1', _causes: ['s1'], shell: undefined, pid: undefined })
    const set = buildCommandIntervals([start('s1', T0, 'c1', 'sleep 60'), boundary])
    expect(set.intervals[0]).toMatchObject({
      endBasis: 'superseded', endTs: T0 + 9000, endId: null, supersededById: 'b1', anchorId: 's1', memberIds: ['s1']
    })
    // The boundary stays a dot of its own.
    expect(set.claimed.has('b1')).toBe(false)
  })

  it('a command_boundary on the same terminal with the same command_id supersedes it', () => {
    const boundary = sh('b1', T0 + 9000, 'command_boundary', { command_id: 'c1', shell: undefined })
    const set = buildCommandIntervals([start('s1', T0, 'c1', 'sleep 60'), boundary])
    expect(set.intervals[0]).toMatchObject({ endBasis: 'superseded', supersededById: 'b1' })
  })

  it('a command_boundary on another terminal does not', () => {
    const boundary = sh('b1', T0 + 9000, 'command_boundary', { command_id: 'c1', terminalId: 't2' })
    expect(buildCommandIntervals([start('s1', T0, 'c1', 'x'), boundary]).intervals[0].endBasis).toBe('open')
  })

  it('a session_end on the same terminal after the start supersedes it; before it, or elsewhere, does not', () => {
    const s1 = start('s1', T0, 'c1', 'tail -f log')
    expect(buildCommandIntervals([s1, sh('x', T0 + 5000, 'session_end')]).intervals[0])
      .toMatchObject({ endBasis: 'superseded', endTs: T0 + 5000, supersededById: 'x' })
    expect(buildCommandIntervals([sh('x', T0 - 5000, 'session_end'), s1]).intervals[0].endBasis).toBe('open')
    expect(buildCommandIntervals([s1, sh('x', T0 + 5000, 'session_end', { terminalId: 't2' })]).intervals[0].endBasis).toBe('open')
  })

  it('an observed end wins over a boundary', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'x'), end('e1', T0 + 10, 'c1', 'x'),
      sh('b1', T0 + 20, 'command_boundary', { command_id: 'c1', _causes: ['s1'] })
    ])
    expect(set.intervals[0]).toMatchObject({ endBasis: 'observed', endId: 'e1', supersededById: null })
  })
})

describe('buildCommandIntervals: order and time', () => {
  it('does not depend on the order the rows arrive in', () => {
    const rows = [
      start('s1', T0, 'c1', 'a'), end('e1', T0 + 10, 'c1', 'a'),
      start('s2', T0 + 20, 'c2', 'b', { terminalId: 't2' }),
      start('s3', T0 + 30, 'c3', 'c'), end('e3', T0 + 25, 'c3', 'c')
    ]
    expect(buildCommandIntervals([...rows].reverse())).toEqual(buildCommandIntervals(rows))
  })

  it('an end stamped before its start is marked reversed, not given a negative length', () => {
    const set = buildCommandIntervals([start('s1', T0 + 5000, 'c1', 'x'), end('e1', T0, 'c1', 'x')])
    expect(set.intervals[0]).toMatchObject({ startTs: T0 + 5000, endTs: T0, reversed: true })
  })

  it('sorts tracks by key and intervals by track, then start (or end), then id', () => {
    const set = buildCommandIntervals([
      start('s9', T0 + 50, 'c9', 'z', { terminalId: 'b' }),
      start('s1', T0 + 10, 'c1', 'a', { terminalId: 'a' }),
      end('e2', T0 + 5, 'c2', 'b', { terminalId: 'a' })
    ])
    expect(set.tracks.map((t) => t.key)).toEqual(['terminal:a', 'terminal:b'])
    expect(set.intervals.map((i) => i.anchorId)).toEqual(['e2', 's1', 's9'])
  })
})

describe('tracks', () => {
  it('a built-in terminal track says so', () => {
    const set = buildCommandIntervals([start('s1', T0, 'c1', 'ls', { source: 'builtin-terminal', terminalId: 'ab12cd34' })])
    expect(set.tracks[0]).toMatchObject({ key: 'terminal:ab12cd34', terminalId: 'ab12cd34', builtin: true })
  })

  it('takes shell and pid from the earliest row that carries them, and leaves them null when none does', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'a', { shell: undefined, pid: undefined }),
      end('e1', T0 + 10, 'c1', 'a', { shell: 'bash', pid: 77 }),
      start('s2', T0 + 20, 'c2', 'b', { terminalId: 't2', pid: undefined })
    ])
    expect(set.tracks.map((t) => [t.shell, t.pid])).toEqual([['bash', 77], ['zsh', null]])
  })

  it('first and last are the known times of its intervals', () => {
    const set = buildCommandIntervals([
      start('s1', T0, 'c1', 'a'), end('e1', T0 + 10, 'c1', 'a'),
      start('s2', T0 + 30, 'c2', 'b')
    ])
    expect(set.tracks[0]).toMatchObject({ firstTs: T0, lastTs: T0 + 30, intervalCount: 2 })
  })
})

describe('terminalTrackKey', () => {
  const at = (data: Extra): Pick<RedLogEvent, 'agentType' | 'data'> => ({ agentType: 'shell', data })
  it('reads the stamp, then terminalId, then terminal_id', () => {
    expect(terminalTrackKey(at({ _ingest: { terminal: 'stamped' }, terminalId: 'sent' }))).toBe('terminal:stamped')
    expect(terminalTrackKey(at({ terminalId: 'sent', terminal_id: 'other' }))).toBe('terminal:sent')
    expect(terminalTrackKey(at({ terminal_id: 7 }))).toBe('terminal:7')
    expect(terminalTrackKey(at({}))).toBeNull()
    expect(terminalTrackKey(at({ terminalId: '' }))).toBeNull()
  })

  it('agrees with core rowTerminal, which the renderer may not import (node:crypto)', () => {
    const cases: Extra[] = [
      { _ingest: { terminal: 'stamped' }, terminalId: 'sent' },
      { _ingest: { door: 'api' }, terminalId: 'sent' },
      { _ingest: { door: 'handoff' }, terminal_id: 'x' },
      { _ingest: { door: 'hook' }, terminalId: 'sent' },
      { _ingest: ['not', 'a', 'stamp'], terminalId: 'sent' },
      { terminalId: 12 }, { terminalId: Number.NaN }, { terminal_id: 'tid' }, {}
    ]
    for (const data of cases) {
      const core = rowTerminal(data)
      expect(terminalTrackKey(at(data)), JSON.stringify(data)).toBe(core === null ? null : `terminal:${core}`)
    }
  })
})

describe('nextTrackOrder', () => {
  const track = (key: string, lastTs: number): TimelineTrack =>
    ({ key, terminalId: key.slice(9), shell: 'zsh', pid: 1, builtin: false, firstTs: 0, lastTs, intervalCount: 1 })

  it('orders a new set by last activity, newest first', () => {
    expect(nextTrackOrder([], [track('terminal:a', 1), track('terminal:b', 3), track('terminal:c', 2)]))
      .toEqual(['terminal:b', 'terminal:c', 'terminal:a'])
  })

  it('keeps the order (the same array) while the set of terminals is unchanged', () => {
    const prev = ['terminal:a', 'terminal:b']
    expect(nextTrackOrder(prev, [track('terminal:a', 1), track('terminal:b', 9)])).toBe(prev)
  })

  it('re-sorts when a terminal appears or goes', () => {
    const prev = ['terminal:a', 'terminal:b']
    expect(nextTrackOrder(prev, [track('terminal:a', 1), track('terminal:b', 2), track('terminal:c', 3)]))
      .toEqual(['terminal:c', 'terminal:b', 'terminal:a'])
    expect(nextTrackOrder(prev, [track('terminal:a', 5)])).toEqual(['terminal:a'])
  })

  it('breaks a tie by key, so the order does not depend on input order', () => {
    expect(nextTrackOrder([], [track('terminal:b', 1), track('terminal:a', 1)])).toEqual(['terminal:a', 'terminal:b'])
  })
})

// SC-001, as a seeded property test. The repository has no property-test
// library; this is the LCG test/timeline-incremental-equivalence.test.ts uses.
describe('SC-001: the intervals agree with the fold on any rows', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  }
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]

  function randomRows(r: () => number): RedLogEvent[] {
    const n = 1 + Math.floor(r() * 24)
    const rows: RedLogEvent[] = []
    for (let i = 0; i < n; i++) {
      const id = `r${i}`
      const ts = T0 + Math.floor(r() * 60_000)
      const cid = pick(r, ['c1', 'c2', 'c3', 'c4'])
      const terminalId = pick(r, ['t1', 't1', 't2', undefined])
      const kind = r()
      const text = r() < 0.85 ? `cmd ${cid}` : `other ${cid}`
      const base: Extra = { terminalId, command_id: r() < 0.9 ? cid : undefined }
      if (kind < 0.4) rows.push(sh(id, ts, 'command_start', { ...base, command: text }))
      else if (kind < 0.8) rows.push(sh(id, ts, 'command_end', { ...base, command: text, exit_code: pick(r, [0, 0, 1, 2]) }))
      else if (kind < 0.88) rows.push(sh(id, ts, 'command_boundary', { ...base, ...(r() < 0.5 && i > 0 ? { _causes: [`r${Math.floor(r() * i)}`] } : {}) }))
      else if (kind < 0.94) rows.push(sh(id, ts, 'session_end', { terminalId }))
      else rows.push({ ...sh(id, ts, 'event', {}), agentType: pick(r, ['browser', 'agent', 'marker']) } as RedLogEvent)
      if (r() < 0.05) (rows[rows.length - 1] as { sessionId: string }).sessionId = ''
    }
    return rows
  }

  const CASES = 10_000

  it(`holds for ${CASES} seeded row sets`, () => {
    const r = rng(78)
    for (let c = 0; c < CASES; c++) {
      const rows = randomRows(r)
      const set: TimelineIntervalSet = buildCommandIntervals(rows)
      const ctx = `case ${c}: ${JSON.stringify(rows.map((e) => [e.id, e.timestamp, e.data.subtype, e.data.command_id, e.data.terminalId, e.data.command, e.data.exit_code]))}`
      const byId = new Map(rows.map((e) => [e.id, e]))

      // A partition: every member belongs to exactly one interval.
      const seen = new Set<string>()
      for (const iv of set.intervals) {
        for (const m of iv.memberIds) {
          expect(seen.has(m), ctx).toBe(false)
          seen.add(m)
          expect(set.byMemberId.get(m), ctx).toBe(iv)
        }
        expect(iv.memberIds, ctx).toContain(iv.anchorId)
        expect(iv.anchorId, ctx).toBe(iv.endId ?? iv.startId)
      }
      expect([...set.claimed].sort(), ctx).toEqual([...seen].sort())

      // Starts the fold hides are exactly the starts that full intervals claim.
      const kept = new Set(collapseCommandPairs(rows).map((e) => e.id))
      const isStart = (id: string): boolean => byId.get(id)?.data.subtype === 'command_start'
      const folded = rows.filter((e) => e.data.subtype === 'command_start' && !kept.has(e.id)).map((e) => e.id).sort()
      const observedStarts = set.intervals.filter((iv) => iv.endBasis === 'observed').flatMap((iv) => iv.memberIds.filter(isStart)).sort()
      expect(observedStarts, ctx).toEqual(folded)

      // Open and superseded intervals hold exactly the unfinished starts.
      const unfinished = [...unfinishedCommandIds(rows)].sort()
      const notEnded = set.intervals.filter((iv) => iv.endBasis !== 'observed').flatMap((iv) => [...iv.memberIds]).sort()
      expect(notEnded, ctx).toEqual(unfinished)
      const open = set.intervals.filter((iv) => iv.endBasis === 'open').flatMap((iv) => [...iv.memberIds])
      const superseded = new Set(set.intervals.filter((iv) => iv.endBasis === 'superseded').flatMap((iv) => [...iv.memberIds]))
      expect(open.sort(), ctx).toEqual(unfinished.filter((id) => !superseded.has(id)))

      // Each interval is one pair key on one terminal, and its ends are its own.
      for (const iv of set.intervals) {
        const keys = new Set(iv.memberIds.map((m) => operationPairKey(byId.get(m)!)))
        expect(keys.size, ctx).toBe(1)
        expect(iv.id, ctx).toBe(`command:${[...keys][0]}`)
        if (iv.startId) expect(iv.startTs, ctx).toBe(byId.get(iv.startId)!.timestamp)
        if (iv.endId) expect(iv.endTs, ctx).toBe(byId.get(iv.endId)!.timestamp)
        if (iv.endBasis === 'open') expect(iv.endTs, ctx).toBeNull()
        expect(iv.reversed, ctx).toBe(iv.startTs !== null && iv.endTs !== null && iv.endTs < iv.startTs)
      }

      // The order the rows arrive in changes nothing.
      expect(buildCommandIntervals([...rows].reverse()), ctx).toEqual(set)
    }
  })
})
