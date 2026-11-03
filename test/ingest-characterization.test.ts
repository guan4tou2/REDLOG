import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// R2-0a: characterization tests for the ingest path (docs/DESIGN-project-
// runtime.md §3, "R2 ... as characterization tests first"). They pin what
// ingest() and insertEvent() do TODAY so the stage refactors (R2-a/b/c/d) and a
// perf fix cannot change it silently.
//
// Where a case says "recorded", the assertion is an observation of current
// behaviour, not a statement that the behaviour is right. Change it knowingly,
// in the commit that changes the behaviour, and say so there.
//
// What is NOT repeated here, because it already has a test:
//   - envelope raw digest inside the hash, enrichment once and only for primary
//     rows, the pause gate's `skipped`/no companions, delayed-byte refusal:
//     test/ingest.test.ts
//   - a bound database refusing another engagement at insertEvent itself:
//     test/db-engagement-guard.test.ts (this file pins it through ingest())
//   - pause gate at insertEvent for every lane: test/pause-gate.test.ts
//   - the queue-gap pure functions: test/mitm-stop-gap.test.ts, spool replay
//     mechanics: test/spool-replay.test.ts, the producer side of a queue-full
//     gap: test/mitm-queue-gap.test.ts
// The HTTP half of the contract is in test/api-ingest-contract.test.ts.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let bindDBEngagement: typeof import('../src/core/db/index').bindDBEngagement
let ingestMod: typeof import('../src/core/ingest')
let events: typeof import('../src/core/db/events')
let chain: typeof import('../src/core/chain-anchor')
let ops: typeof import('../src/core/db/operators')
let spool: typeof import('../src/core/spool-replay')
let gap: typeof import('../src/core/queue-gap')
let busMod: typeof import('../src/core/event-bus')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB; getDB = dbMod.getDB; bindDBEngagement = dbMod.bindDBEngagement
  ingestMod = await import('../src/core/ingest')
  events = await import('../src/core/db/events')
  chain = await import('../src/core/chain-anchor')
  ops = await import('../src/core/db/operators')
  spool = await import('../src/core/spool-replay')
  gap = await import('../src/core/queue-gap')
  busMod = await import('../src/core/event-bus')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('ingest characterization (R2-0a)', () => {
  let tmpDir: string
  let opId: string
  let engagementId: string
  const bus = (): typeof import('../src/core/event-bus').eventBus => busMod.eventBus

  // A fresh project per case: row counts and the 2 s dedup window are state of
  // the open database, and every case below reasons about "no row anywhere".
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ingest-char-'))
    initDB(tmpDir)
    opId = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
    engagementId = 'eng-1'
  })
  afterEach(() => {
    bus().resume('api')
    ingestMod._resetIngest()
    try { closeDB() } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  })

  const base = (): { operatorId: string; engagementId: string } => ({ operatorId: opId, engagementId })
  const ingest = (agentType: string, data: Record<string, unknown>, extra: Partial<import('../src/core/ingest').IngestInput> = {}): import('../src/core/ingest').IngestResult =>
    ingestMod.ingest({ ...base(), agentType, data, ...extra })
  const shell = (data: Record<string, unknown>): import('../src/core/ingest').IngestResult => ingest('shell', data)
  const n = (table: 'events' | 'events_logged'): number =>
    (getDB().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const rowsOf = (table: 'events' | 'events_logged', agentType?: string): Array<Record<string, unknown>> =>
    getDB().prepare(`SELECT * FROM ${table}${agentType ? ' WHERE agent_type = ?' : ''} ORDER BY created_at, rowid`)
      .all(...(agentType ? [agentType] : [])) as Array<Record<string, unknown>>
  /** Everything a subscriber was handed, in delivery order. Fan-out is deferred
   *  by a microtask, so callers flush before reading. */
  const listen = (): { ids: string[]; stop: () => void } => {
    const ids: string[] = []
    const onEvent = (e: { id: string }): void => { ids.push(e.id) }
    bus().on('event', onEvent)
    return { ids, stop: () => bus().off('event', onEvent) }
  }
  const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

  // ── A→B binding ───────────────────────────────────────────────────────────
  describe('A→B binding', () => {
    it('refuses another engagement\'s row in both tiers', async () => {
      // The open database belongs to eng-b; the work in flight is eng-a's.
      bindDBEngagement('eng-b')
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const heard = listen()
      try {
        const chained = ingestMod.ingest({
          operatorId: opId, engagementId: 'eng-a', agentType: 'shell',
          // ssh -D would derive a pivot companion if the primary row landed.
          data: { subtype: 'command_start', command: 'ssh -D 1080 user@10.0.0.9', terminal_id: 'ab-t1', pid: 501 }
        })
        const logged = ingestMod.ingest({
          operatorId: opId, engagementId: 'eng-a', agentType: 'dns',
          data: { subtype: 'dns_query', query_name: 'a.example.', query_type: 'A' }
        })
        await flush()

        // Recorded, not endorsed: a refusal by the database is reported as
        // `skipped: 'dedup'`, the same word as a real duplicate. ingest() only
        // knows insertEvent returned null; the HTTP route then answers 409
        // "Duplicate event". A reader of either cannot tell the two apart.
        expect(chained).toEqual({ event: null, skipped: 'dedup', companions: [] })
        expect(logged).toEqual({ event: null, skipped: 'dedup', companions: [] })
        // No row in either tier, no derived row, nothing published.
        expect(n('events')).toBe(0)
        expect(n('events_logged')).toBe(0)
        expect(heard.ids).toEqual([])
        // Refused loudly through console.error, not through capture health.
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('eng-a'))

        // Control: the bound engagement's own row still lands, so the zero
        // above is the refusal and not a broken fixture.
        const own = ingestMod.ingest({
          operatorId: opId, engagementId: 'eng-b', agentType: 'dns',
          data: { subtype: 'dns_query', query_name: 'b.example.', query_type: 'A' }
        })
        expect(own.event).not.toBeNull()
        expect(n('events_logged')).toBe(1)
      } finally {
        heard.stop()
        errors.mockRestore()
      }
    })
  })

  // ── Pause ─────────────────────────────────────────────────────────────────
  describe('pause', () => {
    it('writes no row, publishes nothing, and derives no companion', async () => {
      const dispatch = vi.fn()
      const loot = { scan: () => [], findMatches: vi.fn(() => []), emit: vi.fn(() => true) }
      ingestMod.configureIngest({ alertRuntime: { dispatchTargetHit: dispatch }, lootDetector: loot })
      const heard = listen()
      bus().pause('api')
      try {
        const results = [
          // chained tier; a pivot companion if it were recorded
          shell({ subtype: 'command_start', command: 'ssh -D 1080 user@10.0.0.9', terminal_id: 'p-t1', pid: 601 }),
          // logged tier: gated too
          ingest('dns', { subtype: 'dns_query', query_name: 'paused.example.', query_type: 'A' })
        ]
        await flush()
        for (const r of results) expect(r).toEqual({ event: null, skipped: 'paused', companions: [] })
        expect(n('events')).toBe(0)
        expect(n('events_logged')).toBe(0)
        expect(heard.ids).toEqual([])
        // Nothing downstream of the gate ran for the paused rows.
        expect(dispatch).not.toHaveBeenCalled()
        expect(loot.emit).not.toHaveBeenCalled()
        for (const derived of ['pivot', 'cleanup', 'file_transfer', 'credential_use']) {
          expect(rowsOf('events', derived), derived).toEqual([])
        }
      } finally {
        heard.stop()
      }
    })
  })

  // ── Queue-full gap through the spool drain ────────────────────────────────
  //
  // `drain` below is a COPY of the closure in src/main/index.ts (drainSpool,
  // ~885-927): replaySpoolDirectory + queueGapAgainstPauses + ingest, with the
  // same return contract. It is not the real closure — that one lives inside
  // the project-open function and cannot be imported. The real closure is
  // pinned end to end by e2e/capture-gap-acceptance.spec.ts; this copy pins the
  // composition of the three pieces it calls. If drainSpool changes, change
  // this copy with it.
  describe('capture gaps through the drain', () => {
    const MIN = 60_000
    // Pause window: [T0 + 10 min, T0 + 20 min]. All in the past, after 2015.
    const T0 = Date.now() - 60 * MIN
    const PAUSE: [number, number] = [T0 + 10 * MIN, T0 + 20 * MIN]
    let spoolDir: string

    beforeEach(() => {
      spoolDir = path.join(tmpDir, 'spool')
      fs.mkdirSync(spoolDir, { recursive: true })
      // The pause is in the record the way the app leaves it: two system rows.
      ingestMod.ingest({ ...base(), agentType: 'system', data: { subtype: 'recording_paused' }, occurredAt: PAUSE[0] })
      ingestMod.ingest({ ...base(), agentType: 'system', data: { subtype: 'recording_resumed' }, occurredAt: PAUSE[1] })
    })

    const spoolFile = (name: string, data: Record<string, unknown>, agentType = 'scanner'): string => {
      const file = path.join(spoolDir, `${name}.json`)
      fs.writeFileSync(file, JSON.stringify({ agent_type: agentType, _identity: { engagementId, operatorId: opId }, data }))
      return file
    }
    const queueFull = (startedAt: number, endedAt: number, reason = 'queue-full'): Record<string, unknown> => ({
      subtype: 'capture_gap', source: 'mitmproxy', reason, capture_delivery: 'not-queued',
      gap_started_at: startedAt, gap_ended_at: endedAt, skipped_units: 7, skipped_body_bytes: 1234, reported_at: endedAt
    })
    const drain = (): import('../src/core/spool-replay').SpoolReplayResult => {
      let pauses: ReturnType<typeof gap.pauseIntervals> | null = null
      const emit = ({ agentType, data: spooled, engagementId: spoolEngagement, operatorId: spoolOperator }: import('../src/core/spool-replay').SpoolReplayEvent): boolean => {
        const data = gap.isPauseJudgedGap(spooled)
          ? gap.queueGapAgainstPauses(spooled, pauses ??= gap.pauseIntervals(events.recordingStateRows()))
          : spooled
        if (!data) return true
        const result = ingestMod.ingest({
          agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator,
          envelope: { source: 'spool', mapper: { id: 'identity', version: '1' } }
        })
        if (result.event) return true
        return result.skipped !== 'paused'
      }
      return spool.replaySpoolDirectory(spoolDir, { engagementId, operatorId: opId }, emit)
    }
    const gaps = (): Array<{ data: Record<string, unknown>; source: unknown }> =>
      rowsOf('events', 'scanner')
        .map((r) => ({ data: JSON.parse(r.data as string) as Record<string, unknown>, source: r.source }))
        .filter((r) => r.data.subtype === 'capture_gap')

    it('lands a queue-full gap outside any pause unchanged', () => {
      const data = queueFull(T0 + 30 * MIN, T0 + 31 * MIN)
      const file = spoolFile('gap-a', data)
      expect(drain()).toEqual({ replayed: 1, deferred: 0, unattributed: 0, invalid: 0, last: 'gap-a.json' })
      expect(fs.existsSync(file)).toBe(false)
      const [row, ...rest] = gaps()
      expect(rest).toEqual([])
      expect(row.data).toEqual({ ...data, recovered_from_spool: true })
      expect(row.data.overlaps_pause).toBeUndefined()
      expect(row.source).toBe('spool')
    })

    it('is done with a gap wholly inside a pause: no row, file consumed', () => {
      const file = spoolFile('gap-inside', queueFull(PAUSE[0] + MIN, PAUSE[1] - MIN))
      expect(drain()).toEqual({ replayed: 1, deferred: 0, unattributed: 0, invalid: 0, last: 'gap-inside.json' })
      expect(gaps()).toEqual([])
      expect(fs.existsSync(file)).toBe(false)
    })

    it('keeps a gap that crosses a pause boundary and says it overlaps', () => {
      spoolFile('gap-start', queueFull(PAUSE[0] - 2 * MIN, PAUSE[0] + 2 * MIN))
      spoolFile('gap-end', queueFull(PAUSE[1] - 2 * MIN, PAUSE[1] + 2 * MIN))
      expect(drain().replayed).toBe(2)
      const rows = gaps()
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(r.data.overlaps_pause).toBe(true)
        expect(r.data.skipped_units).toBe(7)
      }
    })

    it('keeps a delivery-unconfirmed gap inside a pause: its reason is not pause-judged', () => {
      // The producer's own shape (hooks/mitmproxy-addon.py _spool_payload) has
      // no window at all. The window fields are added here so the only thing
      // that can explain the row surviving is the reason, not a missing window.
      const real = {
        subtype: 'capture_gap', source: 'mitmproxy', reason: 'delivery-unconfirmed', capture_delivery: 'unknown',
        reported_at: PAUSE[0] + MIN
      }
      const windowed = { ...real, gap_started_at: PAUSE[0] + MIN, gap_ended_at: PAUSE[1] - MIN }
      spoolFile('unconfirmed-real', real)
      spoolFile('unconfirmed-windowed', windowed)
      expect(gap.isPauseJudgedGap(windowed)).toBe(false)
      expect(drain().replayed).toBe(2)
      const rows = gaps()
      expect(rows.map((r) => r.data.reason)).toEqual(['delivery-unconfirmed', 'delivery-unconfirmed'])
      expect(rows.every((r) => r.data.overlaps_pause === undefined)).toBe(true)
    })

    it('drops a delivery-interrupted gap inside a pause', () => {
      const file = spoolFile('interrupted-inside', queueFull(PAUSE[0] + MIN, PAUSE[1] - MIN, 'delivery-interrupted'))
      expect(drain().replayed).toBe(1)
      expect(gaps()).toEqual([])
      expect(fs.existsSync(file)).toBe(false)
    })
  })

  // ── Dedup (insertEvent's 2 s window, seen through ingest) ─────────────────
  describe('dedup', () => {
    const start = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
      ({ subtype: 'command_start', command, ...extra })

    it('drops the second of the same subtype + command + terminal id within 2 s', () => {
      const first = shell(start('id', { terminal_id: 'd-t1' }))
      const second = shell(start('id', { terminal_id: 'd-t1' }))
      expect(first.event).not.toBeNull()
      expect(second).toEqual({ event: null, skipped: 'dedup', companions: [] })
      expect(n('events')).toBe(1)
    })

    it('lets a start and an end with the same command both land', () => {
      expect(shell(start('id', { terminal_id: 'd-t1' })).event).not.toBeNull()
      expect(shell({ subtype: 'command_end', command: 'id', terminal_id: 'd-t1', exit_code: 0, duration_sec: 0 }).event).not.toBeNull()
      expect(n('events')).toBe(2)
    })

    it('lets the same command in a different terminal land', () => {
      expect(shell(start('id', { terminal_id: 'd-t1' })).event).not.toBeNull()
      expect(shell(start('id', { terminal_id: 'd-t2' })).event).not.toBeNull()
      expect(n('events')).toBe(2)
    })

    it('drops a shell↔agent duplicate only when a terminal id or pid links them', () => {
      expect(shell(start('whoami', { terminal_id: 'x-t1', pid: 700 })).event).not.toBeNull()
      // Same pid: the second is dropped, in either direction of type.
      expect(ingest('agent', start('whoami', { pid: 700 })).skipped).toBe('dedup')
      // Same terminal id, no pid on the second: dropped.
      expect(ingest('agent', start('whoami', { terminal_id: 'x-t1' })).skipped).toBe('dedup')
      // A different pid and a different terminal id: nothing links them.
      expect(ingest('agent', start('whoami', { terminal_id: 'x-other', pid: 701 })).event).not.toBeNull()
      // No linking field on either side: both land.
      expect(shell(start('hostname')).event).not.toBeNull()
      expect(ingest('agent', start('hostname')).event).not.toBeNull()
      expect(rowsOf('events').map((r) => r.agent_type)).toEqual(['shell', 'agent', 'shell', 'agent'])
    })

    it('never dedups logged-tier rows', () => {
      // `agent:thinking` is the logged-tier subtype that can carry a command.
      // The dedup block is in the chained arm only, so an identical second row
      // is simply written.
      const data = { subtype: 'thinking', command: 'id', terminal_id: 'l-t1', pid: 800 }
      expect(events.classifyTier('agent', data)).toBe('logged')
      expect(ingest('agent', { ...data }).event).not.toBeNull()
      expect(ingest('agent', { ...data }).event).not.toBeNull()
      expect(n('events_logged')).toBe(2)
      expect(n('events')).toBe(0)
    })

    it('does not dedup two replays whose source time is an hour old (recorded)', () => {
      // Recorded, not endorsed. The dedup query asks for rows with
      // `timestamp >= now - 2 s`, but `timestamp` is the SOURCE time when the
      // producer supplied one (event-write.ts resolveOccurredAt). The first
      // replay therefore stores a row an hour in the past, the second one's
      // window does not reach it, and an exact duplicate lands. A spool that
      // replays the same file twice (or a hook that retries after a lost ack)
      // writes the row twice.
      const hourAgo = Date.now() - 3_600_000
      const replay = (): ReturnType<typeof shell> =>
        shell({ ...start('id', { terminal_id: 's-t1', pid: 900 }), source_timestamp: hourAgo, recovered_from_spool: true })
      const first = replay()
      const second = replay()
      expect(first.event).not.toBeNull()
      expect(second.event).not.toBeNull()
      expect(second.skipped).toBeUndefined()
      expect(n('events')).toBe(2)
      // Same replays with no source time are the dedup case above.
      const live = (): ReturnType<typeof shell> => shell(start('id', { terminal_id: 's-t2', pid: 901 }))
      live()
      expect(live().skipped).toBe('dedup')
    })
  })

  // ── Hash chain ────────────────────────────────────────────────────────────
  describe('hash chain', () => {
    type ChainRow = { id: string; hash: string; prev_hash: string | null; signature: string | null; agent_type: string }
    const chainRows = (): ChainRow[] =>
      getDB().prepare('SELECT id, hash, prev_hash, signature, agent_type FROM events ORDER BY created_at, rowid').all() as ChainRow[]

    it('links a mixed sequence prev_hash to hash in (created_at, rowid) order, and verifies', async () => {
      bindDBEngagement(engagementId)
      const dup = { subtype: 'command_start', command: 'ssh -D 1080 user@10.0.0.9', terminal_id: 'c-t1', pid: 1001 }
      const withCompanion = shell({ ...dup })                                            // chained + pivot companion
      ingest('dns', { subtype: 'dns_query', query_name: 'c.example.', query_type: 'A' }) // logged
      const duplicate = shell({ ...dup })                                                // dedup
      bus().pause('api')
      ingest('system', { subtype: 'recording_paused' })                                  // exempt: chained
      const paused = shell({ subtype: 'command_start', command: 'hostname', terminal_id: 'c-t2' })
      ingest('marker', { title: 'while paused' })                                        // exempt: chained
      bus().resume('api')
      ingest('system', { subtype: 'recording_resumed' })
      const refused = ingestMod.ingest({ ...base(), engagementId: 'eng-elsewhere', agentType: 'shell', data: { subtype: 'command_start', command: 'uname' } })
      const plumbing = shell({ subtype: 'command_start', command: 'source /opt/redlog/shell-bash-hook.sh', terminal_id: 'c-t3' })
      const after = shell({ subtype: 'command_end', command: 'id', terminal_id: 'c-t1', exit_code: 0, duration_sec: 0 })

      expect(withCompanion.companions).toHaveLength(1)
      expect(duplicate.skipped).toBe('dedup')
      expect(paused.skipped).toBe('paused')
      expect(refused.skipped).toBe('dedup')
      expect(plumbing.skipped).toBe('plumbing')

      const rows = chainRows()
      // Only the chained rows that landed: primary, its pivot, system pause,
      // marker, system resume, command_end.
      expect(rows.map((r) => r.agent_type)).toEqual(['shell', 'pivot', 'system', 'marker', 'system', 'shell'])
      expect(n('events_logged')).toBe(1)
      expect(rows[0].prev_hash).toBeNull()
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].prev_hash, `row ${i} (${rows[i].agent_type})`).toBe(rows[i - 1].hash)
      }
      // The hashes the callers were handed are the hashes stored.
      expect(withCompanion.event!.hash).toBe(rows[0].hash)
      expect(withCompanion.companions[0].prevHash).toBe(rows[0].hash)
      expect(after.event!.prevHash).toBe(rows[4].hash)

      const verified = await chain.verifyChainFullAsync()
      expect(verified.ok, verified.brokenReason ?? '').toBe(true)
      expect(verified.walked).toBe(rows.length)
      expect(verified.badSignatureAtEventId).toBeNull()
      expect(verified.signedCount).toBe(rows.length)
    })

    it('gives logged rows no hash, no prev_hash and no signature, and leaves the chain head alone', () => {
      const before = shell({ subtype: 'command_start', command: 'id', terminal_id: 'g-t1' }).event!
      const logged = ingest('dns', { subtype: 'dns_query', query_name: 'g.example.', query_type: 'A' }).event!
      expect(logged.tier).toBe('logged')
      expect(logged.hash).toBeUndefined()
      expect(logged.prevHash).toBeNull()
      expect(logged.signature).toBeNull()
      // The table has nowhere to put them.
      const columns = (getDB().prepare('PRAGMA table_info(events_logged)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).not.toContain('hash')
      expect(columns).not.toContain('prev_hash')
      expect(columns).not.toContain('signature')
      // The next chained row chains onto the last CHAINED one, not the logged row.
      const after = shell({ subtype: 'command_end', command: 'id', terminal_id: 'g-t1', exit_code: 0, duration_sec: 0 }).event!
      expect(after.prevHash).toBe(before.hash)
      // And the chained rows are signed, so the absence above is the tier.
      expect(before.signature).toEqual(expect.any(String))
    })

    it('still verifies after a rolled-back transaction of inserts, once the head cache is reset', async () => {
      const kept = shell({ subtype: 'command_start', command: 'id', terminal_id: 'r-t1' }).event!
      const db = getDB()
      expect(() => db.transaction(() => {
        shell({ subtype: 'command_start', command: 'ls', terminal_id: 'r-t2' })
        shell({ subtype: 'command_start', command: 'pwd', terminal_id: 'r-t3' })
        throw new Error('roll back')
      })()).toThrow('roll back')
      expect(n('events')).toBe(1)
      // insertEvent advanced its cached head to the rolled-back row's hash;
      // anything that rolls back inserts has to say so.
      events.invalidateChainHeadCache()
      const next = shell({ subtype: 'command_start', command: 'whoami', terminal_id: 'r-t4' }).event!
      expect(next.prevHash).toBe(kept.hash)
      const verified = await chain.verifyChainFullAsync()
      expect(verified.ok, verified.brokenReason ?? '').toBe(true)
      expect(verified.walked).toBe(2)
    })
  })

  // ── Order ─────────────────────────────────────────────────────────────────
  describe('order', () => {
    it('publishes the primary row before its companions, and subscribers see insert order', async () => {
      const heard = listen()
      // What was already in the table at the moment each publish happened.
      const atPublish: Array<{ id: string; rows: number }> = []
      const publish = bus().publish.bind(bus())
      const spy = vi.spyOn(bus(), 'publish').mockImplementation((e, o) => {
        atPublish.push({ id: e.id, rows: n('events') })
        publish(e, o)
      })
      try {
        // A download with a password flag: two companions from one command_start.
        const r = shell({
          subtype: 'command_start', terminal_id: 'o-t1', pid: 1101,
          command: 'wget --password=Passw0rd123 -O /tmp/x http://10.0.0.9/x'
        })
        await flush()
        expect(r.event).not.toBeNull()
        // Companion order is the order the pipeline emits them in.
        expect(r.companions.map((c) => `${c.agentType}:${c.data.subtype}`)).toEqual(['file_transfer:download', 'credential_use:password_flag'])
        const insertOrder = (getDB().prepare('SELECT id FROM events ORDER BY created_at, rowid').all() as Array<{ id: string }>).map((x) => x.id)
        expect(insertOrder).toEqual([r.event!.id, ...r.companions.map((c) => c.id)])
        expect(heard.ids).toEqual(insertOrder)
        // The primary was published when it was the only row there; each
        // companion when it had just been written after it.
        expect(atPublish.map((p) => p.id)).toEqual(insertOrder)
        expect(atPublish.map((p) => p.rows)).toEqual(insertOrder.map((_, i) => i + 1))
      } finally {
        spy.mockRestore()
        heard.stop()
      }
    })

    it('dispatches scope after the insert, citing the new row\'s id', () => {
      const seen: Array<{ target: string; source: string; action: string; sourceEventId?: string | null; rowExisted: boolean }> = []
      ingestMod.configureIngest({
        alertRuntime: {
          dispatchTargetHit: (input) => {
            const row = getDB().prepare('SELECT id FROM events WHERE id = ?').get(input.sourceEventId ?? '')
            seen.push({ ...input, rowExisted: row !== undefined })
          }
        }
      })
      const r = shell({ subtype: 'command_start', command: 'curl https://10.0.0.9/status', terminal_id: 's-t1', pid: 1201 })
      expect(r.event).not.toBeNull()
      expect(seen).toEqual([{
        target: '10.0.0.9', source: 'shell', action: 'curl https://10.0.0.9/status', sourceEventId: r.event!.id, rowExisted: true
      }])
      // A row that never landed dispatches nothing.
      shell({ subtype: 'command_start', command: 'curl https://10.0.0.9/status', terminal_id: 's-t1', pid: 1201 })
      expect(seen).toHaveLength(1)
    })

    it('scans a large command_end for loot before its stdout moves to the body file', () => {
      const secret = 'AKIAIOSFODNN7EXAMPLE'
      const stdout = `${'filler line\n'.repeat(500)}aws_access_key_id=${secret}\n${'trailing line\n'.repeat(50)}`
      expect(stdout.length).toBeGreaterThan(4096)
      const scanned: string[] = []
      const emitted: Array<{ matches: Array<{ value: string }>; opts: { targetId?: string; source?: string; causeEventId?: string } }> = []
      ingestMod.configureIngest({
        lootDetector: {
          scan: () => [],
          findMatches: (text: string) => {
            scanned.push(text)
            const m = /AKIA[A-Z0-9]{16}/.exec(text)
            return m ? [{ ruleId: 'aws', type: 'aws_key', value: m[0], line: m[0], confidence: 'high' as const }] : []
          },
          emit: (matches, opts) => { emitted.push({ matches, opts }); return true }
        }
      })
      const r = shell({
        subtype: 'command_end', command: 'cat /root/.aws/credentials', terminal_id: 'l-t1',
        exit_code: 0, duration_sec: 0, stdout
      })
      const ev = r.event!
      // Found: the scan read the secret out of the stdout while it was still
      // inline, and the match was emitted citing the row that landed.
      expect(scanned.some((t) => t.includes(secret))).toBe(true)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].matches.map((m) => m.value)).toEqual([secret])
      expect(emitted[0].opts.causeEventId).toBe(ev.id)
      // Moved: the row carries a reference, the bytes are whole in the file.
      expect(ev.data.stdout).toBeUndefined()
      const ref = ev.data.stdout_ref as { file: string; size: number }
      expect(ref.size).toBe(Buffer.byteLength(stdout))
      expect(fs.readFileSync(path.join(tmpDir, 'http-bodies', ref.file), 'utf8')).toBe(stdout)
      // Recorded, not endorsed: detectRedactions runs AFTER the move and reads
      // only fields still inline, so the secret that the loot scan found in
      // the stdout gets no redaction span at all. The row has none.
      expect(ev.data.redactions).toBeUndefined()
    })
  })
})
