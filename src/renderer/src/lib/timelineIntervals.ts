// Spec 078: a terminal's commands as intervals on the Timeline, one track per
// terminal.
//
// The seam Spec 074 FR-100 replaces: today the intervals are paired from the
// rows the page has loaded; once the query worker keeps an `intervals`
// projection, a converter produces the same TimelineIntervalSet from it and
// nothing that draws them changes. The set is plain data (ids, times, the end's
// basis, the command text, the exit code), never an event object.
//
// The pairing is not a second rule. Which starts pair with an end is what the
// Timeline's fold already says (collapseCommandPairs), and which starts have no
// end is unfinishedCommandIds; both key on operationPairKey. SC-001 in
// test/timeline-intervals.test.ts checks the agreement over random rows.
//
// Kinds are looked up in ROLE, not compared as literals
// (test/kinds/kind-literal-ratchet.test.ts only goes down).

import type { RedLogEvent } from '../../../core/db/event-types'
import { operationPairKey } from '../../../core/operation-pair-key'
import { collapseCommandPairs, unfinishedCommandIds } from './timelineEvents'
import { sameSourceContent } from './eventContent'

/** The three of 074 FR-043's closed list a command can have. */
export type IntervalEndBasis = 'observed' | 'superseded' | 'open'

/** Plain data: no event objects, so 074's projection rows convert to it. */
export interface TimelineInterval {
  /** `command:${operationPairKey}`. React key and test identity. */
  id: string
  kind: 'command'
  /** 074 intervals.key: `terminal:<id>`. */
  trackKey: string
  /** null: the start row is not among the input rows (074 FR-049). */
  startId: string | null
  startTs: number | null
  /** Only when endBasis === 'observed': the paired command_end. */
  endId: string | null
  /** observed: the command_end's time; superseded: the superseding row's; open: null. */
  endTs: number | null
  endBasis: IntervalEndBasis
  /** When superseded, the row that did it (command_boundary or session_end). It stays a dot. */
  supersededById: string | null
  /** The row selecting this interval selects: endId ?? startId. */
  anchorId: string
  /** The rows this interval stands for (every start of its key, and the end). */
  memberIds: readonly string[]
  /** The command as drawn, before safeDisplay; the start's, else the end's. */
  command: string
  /** The numeric exit code when observed and recorded, else null. */
  exitCode: number | null
  /** The end row's duration_sec (source-reported), else null. Only for a title when the start is unknown. */
  reportedDurationSec: number | null
  /** endTs < startTs. */
  reversed: boolean
}

export interface TimelineTrack {
  /** `terminal:<id>`. */
  key: string
  terminalId: string
  /** The label's facts, from the track's earliest row that carries them; not inferred. */
  shell: string | null
  pid: number | null
  builtin: boolean
  /** The earliest and latest known time among the track's intervals. */
  firstTs: number
  lastTs: number
  intervalCount: number
}

export interface TimelineIntervalSet {
  /** By key (stable). Row order is nextTrackOrder's, not this. */
  tracks: readonly TimelineTrack[]
  /** By (trackKey, startTs ?? endTs, id). */
  intervals: readonly TimelineInterval[]
  /** Every memberId. */
  claimed: ReadonlySet<string>
  byMemberId: ReadonlyMap<string, TimelineInterval>
}

type Role = 'start' | 'end' | 'boundary' | 'session-end'

const ROLE: ReadonlyMap<string, Role> = new Map([
  ['shell\u0000command_start', 'start'],
  ['shell\u0000command_end', 'end'],
  ['shell\u0000command_boundary', 'boundary'],
  ['shell\u0000session_end', 'session-end']
])

function roleOf(e: Pick<RedLogEvent, 'agentType' | 'data'>): Role | undefined {
  return ROLE.get(`${e.agentType}\u0000${String(e.data?.subtype ?? '')}`)
}

/** Whether a row takes part in any interval: a command's start, end or
 *  boundary, or a terminal's end. A batch without one changes nothing. */
export function isIntervalRow(e: Pick<RedLogEvent, 'agentType' | 'data'>): boolean {
  return roleOf(e) !== undefined
}

function terminalValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value !== '' ? value : null
}

/** The row's track: `terminal:<id>` from its terminal identity, or null.
 *  The same reading as core's rowTerminal (src/core/ingest/terminal.ts, which
 *  the renderer cannot import: it takes node:crypto in), including that a
 *  stamp from the api or handoff door without a terminal means none. A stored
 *  row's identity is already in normal form, so none is applied here. */
export function terminalTrackKey(e: Pick<RedLogEvent, 'agentType' | 'data'>): string | null {
  const d = (e.data ?? {}) as Record<string, unknown>
  const stamp = d._ingest
  if (stamp !== null && typeof stamp === 'object' && !Array.isArray(stamp)) {
    const { terminal, door } = stamp as Record<string, unknown>
    if (typeof terminal === 'string') return `terminal:${terminal}`
    if (door === 'api' || door === 'handoff') return null
  }
  const id = terminalValue(d.terminalId) ?? terminalValue(d.terminal_id)
  return id === null ? null : `terminal:${id}`
}

const byTime = (a: RedLogEvent, b: RedLogEvent): number =>
  a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const earliest = (rows: readonly RedLogEvent[]): RedLogEvent | undefined =>
  rows.reduce<RedLogEvent | undefined>((best, e) => (!best || byTime(e, best) < 0 ? e : best), undefined)

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Today's source: the page's loaded rows. 074 FR-100 replaces it with a
 *  converter from the `intervals` projection producing the same type. */
export function buildCommandIntervals(rows: readonly RedLogEvent[]): TimelineIntervalSet {
  const groups = new Map<string, { starts: RedLogEvent[]; ends: RedLogEvent[] }>()
  const commandRows: RedLogEvent[] = []
  const boundaryByCause = new Map<string, RedLogEvent[]>()
  const boundaryByCommand = new Map<string, RedLogEvent[]>()
  const sessionEnds = new Map<string, RedLogEvent[]>()
  for (const e of rows) {
    const role = roleOf(e)
    if (role === 'start' || role === 'end') {
      commandRows.push(e)
      const key = operationPairKey(e)
      if (!key) continue
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { starts: [], ends: [] }))
      ;(role === 'start' ? g.starts : g.ends).push(e)
    } else if (role === 'boundary') {
      const causes = (e.data as { _causes?: unknown })._causes
      if (Array.isArray(causes)) for (const c of causes) if (typeof c === 'string') push(boundaryByCause, c, e)
      const track = terminalTrackKey(e)
      const cid = e.data?.command_id
      if (track && typeof cid === 'string' && cid) push(boundaryByCommand, `${track}\u0000${cid}`, e)
    } else if (role === 'session-end') {
      const track = terminalTrackKey(e)
      if (track) push(sessionEnds, track, e)
    }
  }
  if (groups.size === 0) return EMPTY

  // The fold decides; it reads only command rows, so the subset answers the same.
  const shown = new Set(collapseCommandPairs(commandRows))
  const unfinished = unfinishedCommandIds(commandRows)

  const intervals: TimelineInterval[] = []
  const trackRows = new Map<string, RedLogEvent[]>()
  for (const [key, { starts, ends }] of groups) {
    starts.sort(byTime)
    ends.sort(byTime)
    let members: RedLogEvent[]
    let endRow: RedLogEvent | null = null
    let endBasis: IntervalEndBasis = 'open'
    let superseder: RedLogEvent | null = null
    if (ends.length > 0) {
      // Two ends that say different things: the fold keeps every row, so do we.
      if (ends.some((e) => !sameSourceContent(ends[0].data, e.data))) continue
      const paired = starts.filter((s) => !shown.has(s))
      // Starts loaded but none folded: their text differs from the end's.
      if (starts.length > 0 && paired.length === 0) continue
      members = [...paired, ...ends]
      endRow = ends[0]
      endBasis = 'observed'
    } else {
      members = starts.filter((s) => unfinished.has(s.id))
      if (members.length === 0) continue
    }
    const startRow = endBasis === 'observed' && members[0] === endRow ? null : members[0]
    const first = startRow ?? endRow!
    const track = terminalTrackKey(first)
    if (!track) continue
    if (endBasis === 'open' && startRow) {
      superseder = supersederOf(startRow, members, track, boundaryByCause, boundaryByCommand, sessionEnds)
      if (superseder) endBasis = 'superseded'
    }
    const startTs = startRow ? startRow.timestamp : null
    const endTs = endRow ? endRow.timestamp : superseder ? superseder.timestamp : null
    const command = typeof startRow?.data.command === 'string' ? startRow.data.command
      : typeof endRow?.data.command === 'string' ? endRow.data.command : ''
    intervals.push({
      id: `command:${key}`,
      kind: 'command',
      trackKey: track,
      startId: startRow ? startRow.id : null,
      startTs,
      endId: endRow ? endRow.id : null,
      endTs,
      endBasis,
      supersededById: superseder ? superseder.id : null,
      anchorId: (endRow ?? startRow!).id,
      memberIds: members.map((m) => m.id),
      command,
      exitCode: endRow ? numberOrNull(endRow.data.exit_code) : null,
      reportedDurationSec: endRow ? numberOrNull(endRow.data.duration_sec) : null,
      reversed: startTs !== null && endTs !== null && endTs < startTs
    })
    const list = trackRows.get(track)
    if (list) list.push(...members); else trackRows.set(track, [...members])
  }
  if (intervals.length === 0) return EMPTY

  intervals.sort((a, b) => cmp(a.trackKey, b.trackKey)
    || ((a.startTs ?? a.endTs ?? 0) - (b.startTs ?? b.endTs ?? 0)) || cmp(a.id, b.id))

  const tracks: TimelineTrack[] = []
  for (const [key, members] of trackRows) {
    members.sort(byTime)
    const own = intervals.filter((iv) => iv.trackKey === key)
    const times = own.flatMap((iv) => [iv.startTs, iv.endTs]).filter((t): t is number => t !== null)
    tracks.push({
      key,
      terminalId: key.slice('terminal:'.length),
      shell: firstValue(members, (e) => (typeof e.data.shell === 'string' && e.data.shell ? e.data.shell : null)),
      pid: firstValue(members, (e) => numberOrNull(e.data.pid)),
      builtin: members.some((e) => e.data.source === 'builtin-terminal'),
      firstTs: Math.min(...times),
      lastTs: Math.max(...times),
      intervalCount: own.length
    })
  }
  tracks.sort((a, b) => cmp(a.key, b.key))

  const byMemberId = new Map<string, TimelineInterval>()
  for (const iv of intervals) for (const m of iv.memberIds) byMemberId.set(m, iv)
  return { tracks, intervals, claimed: new Set(byMemberId.keys()), byMemberId }
}

const EMPTY: TimelineIntervalSet = { tracks: [], intervals: [], claimed: new Set(), byMemberId: new Map() }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k)
  if (list) list.push(v); else m.set(k, [v])
}

function firstValue<T>(rows: readonly RedLogEvent[], read: (e: RedLogEvent) => T | null): T | null {
  for (const e of rows) { const v = read(e); if (v !== null) return v }
  return null
}

/** FR-005 `superseded`: a command_boundary pointing at the start (by
 *  `_causes`, or the same terminal and command_id), else the terminal's first
 *  session_end at or after the start. */
function supersederOf(
  start: RedLogEvent,
  starts: readonly RedLogEvent[],
  track: string,
  byCause: ReadonlyMap<string, RedLogEvent[]>,
  byCommand: ReadonlyMap<string, RedLogEvent[]>,
  sessionEnds: ReadonlyMap<string, RedLogEvent[]>
): RedLogEvent | null {
  const boundaries: RedLogEvent[] = []
  for (const s of starts) boundaries.push(...(byCause.get(s.id) ?? []))
  const cid = start.data.command_id
  if (typeof cid === 'string') boundaries.push(...(byCommand.get(`${track}\u0000${cid}`) ?? []))
  const boundary = earliest(boundaries)
  if (boundary) return boundary
  return earliest((sessionEnds.get(track) ?? []).filter((e) => e.timestamp >= start.timestamp)) ?? null
}

/** The terminal rows' order (FR-012): unchanged — the very same array — while
 *  the set of terminals is; when a terminal appears or goes, every row is
 *  re-sorted by last activity, newest first. Two terminals taking turns never
 *  swap rows. */
export function nextTrackOrder(prev: readonly string[], tracks: readonly TimelineTrack[]): string[] {
  if (prev.length === tracks.length) {
    const keys = new Set(tracks.map((t) => t.key))
    if (prev.every((k) => keys.has(k))) return prev as string[]
  }
  return [...tracks].sort((a, b) => b.lastTs - a.lastTs || cmp(a.key, b.key)).map((t) => t.key)
}
