import { getDB } from '../../src/core/db/index'

// Rows for the Timeline's query tests (spec 038), written straight into either
// tier like export-fixtures.ts does, so a test can place a row exactly: its
// table, time, operator and target. The FTS triggers still index each insert.

export interface FixtureRow {
  table: 'events' | 'events_logged'
  id: string
  timestamp: number
  agentType: string
  subtype: string
  operatorId: string
  targetId: string | null
  data: Record<string, unknown>
}

export function insertFixtureRow(row: FixtureRow): void {
  const chained = row.table === 'events'
  getDB().prepare(`
    INSERT INTO ${row.table} (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at
      ${chained ? ', hash, prev_hash, signature' : ''})
    VALUES (?, ?, 'eng-1', 's', ?, ?, ?, '', '', ?, ?, ?
      ${chained ? ", 'h', 'p', 's'" : ''})
  `).run(row.id, row.timestamp, row.operatorId, row.agentType, row.subtype, row.targetId,
    JSON.stringify({ subtype: row.subtype, ...row.data }), row.timestamp)
}

export interface TimelineFixture {
  rows: FixtureRow[]
  /** Newest first, which is the canonical order for distinct timestamps. */
  byNewest: FixtureRow[]
  housekeeping: FixtureRow[]
  marker: FixtureRow
  amendment: FixtureRow
  /** Rows naming 10.0.0.5 only in `data.host` / `data.remote_addr`. */
  hostOnly: FixtureRow[]
}

const OLDER_TYPES = ['dns', 'scanner', 'shell', 'agent'] as const
const TARGETS = ['Example.COM', 'example.com', '10.0.0.5', '10.0.0.50', null] as const

/**
 * `total` ordinary rows one `stepMs` apart ending at `start`, the newest
 * `newestShell` of them all `shell`. Tiers alternate. Operators alternate
 * `op-1` / `op-2`. Around them: two housekeeping rows, a marker with one
 * amendment, and two rows that mention 10.0.0.5 only as an observation.
 */
export function seedTimelineFixture(opts: {
  total?: number
  newestShell?: number
  start?: number
  stepMs?: number
} = {}): TimelineFixture {
  const total = opts.total ?? 1200
  const newestShell = opts.newestShell ?? 200
  const start = opts.start ?? 1_700_000_000_000
  const stepMs = opts.stepMs ?? 1000
  const rows: FixtureRow[] = []

  for (let i = 0; i < total; i++) {
    const agentType = i < newestShell ? 'shell' : OLDER_TYPES[i % OLDER_TYPES.length]
    const targetId = TARGETS[i % TARGETS.length]
    const subtype = agentType === 'shell' ? 'command_end' : agentType === 'dns' ? 'query' : 'event'
    rows.push({
      table: i % 2 === 0 ? 'events' : 'events_logged',
      id: `fx-${i}`,
      timestamp: start - i * stepMs,
      agentType,
      subtype,
      operatorId: i % 2 === 0 ? 'op-1' : 'op-2',
      targetId,
      data: {
        command: targetId ? `nmap -sV ${targetId} run-${i}` : `whoami run-${i}`,
        ...(agentType === 'agent' ? { session_id: i % 8 === 3 ? 'S1' : 'S2' } : {})
      }
    })
  }

  const oldest = start - total * stepMs
  const housekeeping: FixtureRow[] = [
    { table: 'events', id: 'fx-hk-api', timestamp: oldest - 1_000, agentType: 'system', subtype: 'api_started', operatorId: 'op-1', targetId: null, data: {} },
    { table: 'events', id: 'fx-hk-session', timestamp: start - 500, agentType: 'shell', subtype: 'session_start', operatorId: 'op-1', targetId: null, data: {} }
  ]
  const marker: FixtureRow = {
    table: 'events', id: 'fx-marker', timestamp: oldest - 5_000, agentType: 'marker', subtype: 'marker',
    operatorId: 'op-1', targetId: '10.0.0.5', data: { title: 'original title', severity: 'high' }
  }
  const amendment: FixtureRow = {
    table: 'events', id: 'fx-amendment', timestamp: start - 250, agentType: 'marker', subtype: 'amended',
    operatorId: 'op-1', targetId: null, data: { markerId: 'fx-marker', title: 'amended title' }
  }
  const hostOnly: FixtureRow[] = [
    { table: 'events_logged', id: 'fx-host-1', timestamp: start - 750, agentType: 'scanner', subtype: 'http_request_start', operatorId: 'op-2', targetId: null, data: { host: '10.0.0.5' } },
    { table: 'events_logged', id: 'fx-host-2', timestamp: start - 1_250, agentType: 'scanner', subtype: 'connection', operatorId: 'op-2', targetId: null, data: { remote_addr: '10.0.0.5' } }
  ]

  rows.push(...housekeeping, marker, amendment, ...hostOnly)
  // One transaction, not 1250. Each bare INSERT is its own implicit
  // transaction with its own commit, which on a loaded Windows runner took
  // the seeding past the 15s hook timeout and failed the file — while
  // passing in about a second locally.
  getDB().transaction(() => { for (const row of rows) insertFixtureRow(row) })()
  const byNewest = [...rows].sort((a, b) => b.timestamp - a.timestamp)
  return { rows, byNewest, housekeeping, marker, amendment, hostOnly }
}

export const HOUSEKEEPING_IDS = ['fx-hk-api', 'fx-hk-session']
