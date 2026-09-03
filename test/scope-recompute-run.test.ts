import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Design turn 8a against a real database. The planner is unit-tested in
// scope-recompute.test.ts; what can only go wrong here is the join — deriving
// the judged target with SQL instead of by parsing every row, matching
// violations to the events they cover across two tables, and appending the
// result without ever leaving the chain half-written.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let runner: typeof import('../src/core/scope-recompute-run') | null = null
let sanitizeMod: typeof import('../src/core/sanitize') | null = null
let chain: typeof import('../src/core/chain-anchor') | null = null
let policies: typeof import('../src/core/alert/policies') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  runner = await import('../src/core/scope-recompute-run')
  sanitizeMod = await import('../src/core/sanitize')
  chain = await import('../src/core/chain-anchor')
  policies = await import('../src/core/alert/policies')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = events !== null
const IDS = { engagementId: 'eng', operatorId: 'op' }
const scope = (targets: string[], excludeTargets: string[] = []): import('../src/core/scope-recompute').ScopeSnapshot =>
  ({ targets, excludeTargets, alertFloor: policies!.alertFloorFor(true) })

describe.skipIf(!available)('running a scope recompute', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-recompute-'))
    dbmod!.initDB(dir)
  })
  afterEach(() => {
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const shell = (target: string, command = `curl ${target}`): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('shell', { subtype: 'command_start', detectedTarget: target, command }, IDS)!
  const dns = (name: string): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('dns', { subtype: 'dns_query', query_name: name, query_type: 'A' }, IDS)!
  const http = (host: string): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('scanner', { subtype: 'http_request_start', host, method: 'GET', url: `https://${host}/` }, IDS)!
  const liveViolation = (target: string, sourceEventId: string | null, distance = 'excluded'): import('../src/core/db/events').RedLogEvent =>
    events!.insertEvent('system', {
      subtype: 'scope_violation', target, action: `curl ${target}`, source: 'shell',
      distance, authority: 'fact', severity: 'critical',
      ...(sourceEventId ? { _causes: [sourceEventId] } : {})
    }, { ...IDS, targetId: target })!

  const rowsOfSubtype = (subtype: string): Array<Record<string, unknown>> =>
    events!.queryEvents({ limit: 1000, tier: 'all' })
      .filter((e) => e.agentType === 'system' && e.data?.subtype === subtype)
      .map((e) => e.data)

  describe('finding candidates without parsing every row', () => {
    it('derives the judged target from SQL exactly as the live path derives it', () => {
      // The DNS case is why this cannot group on target_id: the producer stores
      // the FQDN form with its trailing dot, the live verdict judged the
      // stripped one, and the domain matcher compares exactly.
      shell('evil.example')
      dns('evil.example.')
      http('api.target.com')
      const { candidates } = runner!.scanCandidates()
      expect([...candidates.keys()].sort()).toEqual(['api.target.com', 'evil.example'])
      expect(candidates.get('evil.example')!.count).toBe(2)
    })

    it('reads both tiers — most of the corpus is in the logged table', () => {
      // dns_query and http_request_start are LOGGED_TIER; only shell is chained.
      // A scan of `events` alone would miss nearly everything.
      dns('a.example.')
      http('b.example')
      shell('c.example')
      const { scanned } = runner!.scanCandidates()
      expect(scanned.chained).toBe(1)
      expect(scanned.logged).toBe(2)
    })

    it('ignores rows that carry a host but were never judged live', () => {
      events!.insertEvent('scanner', { subtype: 'connection', host: 'never.judged', remoteAddr: '1.2.3.4' }, IDS)
      events!.insertEvent('shell', { subtype: 'command_end', detectedTarget: 'never.judged', exitCode: 0 }, IDS)
      expect(runner!.scanCandidates().candidates.has('never.judged')).toBe(false)
    })
  })

  describe('appending the re-judgement', () => {
    it('flags an event that was out of scope all along, and never touches it', async () => {
      const e = shell('evil.example')
      const before = dbmod!.getDB().prepare('SELECT * FROM events WHERE id = ?').get(e.id)
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      expect(dbmod!.getDB().prepare('SELECT * FROM events WHERE id = ?').get(e.id)).toEqual(before)
      const retro = rowsOfSubtype('scope_violation')
      expect(retro).toHaveLength(1)
      expect(retro[0]).toMatchObject({ judged: 'retroactive', target: 'evil.example', distance: 'excluded' })
      expect((retro[0]._causes as string[])[0]).toBe(e.id)
    })

    it('writes one summary carrying counts that match the rows', async () => {
      // Distinct commands: insertEvent has a dedup window, so two identical
      // payloads back to back would silently be one row and this test would be
      // asserting against a corpus it does not have.
      shell('evil.example', 'curl evil.example/a')
      shell('evil.example', 'curl evil.example/b')
      shell('www.target.com')
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      const [summary] = rowsOfSubtype('scope_recomputed')
      expect(summary).toMatchObject({ newly_flagged: 2, newly_flagged_written: 2, cleared: 0 })
      expect(rowsOfSubtype('scope_violation')).toHaveLength(2)
      // The first number is everything re-judged, not just what changed.
      expect(summary.recomputed).toBeGreaterThanOrEqual(2)
    })

    it('makes retroactive distinguishable from live using nothing but the row', async () => {
      const e = shell('evil.example')
      liveViolation('other.example', null)
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      const rows = rowsOfSubtype('scope_violation')
      const live = rows.find((d) => d.target === 'other.example')!
      const retro = rows.find((d) => d.target === 'evil.example')!
      expect(live.judged).toBeUndefined()      // absence means live — no migration
      expect(retro).toMatchObject({ judged: 'retroactive', source_tier: 'chained' })
      expect(retro.source_ts).toBe(events!.queryEventById(e.id)!.timestamp)
    })

    it('withdraws a standing violation with a record, never a deletion', async () => {
      const e = shell('evil.example')
      const v = liveViolation('evil.example', e.id)
      const countBefore = events!.getEventCount()
      await runner!.runScopeRecompute({
        before: scope(['*.target.com'], ['evil.example']), after: scope(['*.target.com', 'evil.example']), ...IDS
      })
      // The violation is still there, byte for byte; a new row says it no
      // longer holds.
      expect(events!.queryEventById(v.id)).toBeTruthy()
      expect(events!.getEventCount()).toBeGreaterThan(countBefore)
      const [cleared] = rowsOfSubtype('scope_cleared')
      expect(cleared).toMatchObject({ violation_id: v.id, distance_before: 'excluded', distance_after: 'in_scope' })
      expect(runner!.countActiveScopeViolations()).toBe(0)
    })

    it('clears a violation whose source row has been pruned', async () => {
      // The logged tier is swept after 30 days. Computing withdrawals from the
      // violation records rather than from a rescan is what keeps this working.
      const d = dns('evil.example.')
      liveViolation('evil.example', d.id)
      dbmod!.getDB().prepare('DELETE FROM events_logged WHERE id = ?').run(d.id)
      await runner!.runScopeRecompute({
        before: scope(['*.target.com'], ['evil.example']), after: scope(['*.target.com', 'evil.example']), ...IDS
      })
      expect(rowsOfSubtype('scope_cleared')).toHaveLength(1)
    })

    it('does nothing at all when the scope is unconfigured', async () => {
      shell('evil.example')
      liveViolation('evil.example', null)
      const before = events!.getEventCount()
      const r = await runner!.runScopeRecompute({
        before: scope(['*.target.com'], ['evil.example']), after: scope([]), ...IDS
      })
      expect(r).toMatchObject({ ran: false, reason: 'unconfigured' })
      expect(events!.getEventCount()).toBe(before)
    })

    it('writes nothing when the boundary did not move', async () => {
      shell('www.target.com')
      const before = events!.getEventCount()
      const r = await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com']), ...IDS
      })
      expect(r.ran).toBe(false)
      expect(events!.getEventCount()).toBe(before)
    })

    it('does not mistake an in-scope verdict for a standing violation', async () => {
      // Every verdict is written under the same subtype, including `in_scope` —
      // the adherence counter needs the positive proof. Counting one as a
      // standing violation would turn a newly-excluded host into a "regrade" of
      // something that was never flagged, and the banner's 新標 would read 0
      // while three commands had just been marked out of scope.
      const e = shell('evil.example')
      events!.insertEvent('system', {
        subtype: 'scope_violation', target: 'evil.example', action: 'curl evil.example',
        source: 'shell', distance: 'in_scope', authority: 'unknown', severity: 'clean',
        _causes: [e.id]
      }, { ...IDS, targetId: 'evil.example' })
      expect(runner!.countActiveScopeViolations(), 'in_scope counted as a violation').toBe(0)
      expect(runner!.queryScopeViolationRows()).toHaveLength(0)

      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      const [summary] = rowsOfSubtype('scope_recomputed')
      expect(summary.newly_flagged).toBe(1)
      expect(summary.regraded).toBe(0)
    })

    it('leaves the chain verifying', async () => {
      shell('evil.example'); dns('evil.example.')
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      expect(chain!.verifyChainFull().ok).toBe(true)
    })
  })

  describe('the sanitize overlay', () => {
    it('rebuilds the action from the redacted text, not the raw bytes', async () => {
      // Replacements are keyed by SOURCE event id and applied at export time,
      // so a retroactive row copying the raw command would be a NEW row no
      // overlay covers — and the bundle would ship the plaintext the operator
      // asked to have removed.
      const secret = 'placeholder' + '-' + '0123456789abcdef'
      const e = events!.insertEvent('shell', {
        subtype: 'command_start', detectedTarget: 'evil.example',
        command: `curl -H "auth: ${secret}" evil.example`,
        redactions: [{ field: 'command', pattern: 'denylist', hint: 'x', start: 15, end: 15 + secret.length }]
      }, IDS)!
      sanitizeMod!.sanitize({ eventIds: [e.id], fields: ['command'], ...IDS })
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      const [retro] = rowsOfSubtype('scope_violation')
      expect(String(retro.action)).not.toContain(secret)
      expect(retro.source_sanitized).toBe(true)
    })
  })

  describe('atomicity', () => {
    it('writes nothing and leaves the chain head usable when a write throws', async () => {
      shell('evil.example')
      const before = events!.getEventCount()
      // The failure is forced through the real path: insertEvent refuses a row
      // with no operator, so the summary insert throws inside the transaction.
      const r = await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']),
        engagementId: 'eng', operatorId: ''
      })
      expect(r.ran).toBe(false)
      expect(events!.getEventCount()).toBe(before)

      // And the app can still write: the chain head cache was invalidated, so
      // the next row chains onto what is really in the table.
      const next = events!.insertEvent('marker', { title: 'after the rollback', severity: 'info' }, IDS)
      expect(next).toBeTruthy()
      expect(chain!.verifyChainFull().ok).toBe(true)
    })
  })

  describe('the read model the Scope page uses', () => {
    it('lists retroactive rows and marks the withdrawn ones', async () => {
      const e = shell('evil.example')
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      let rows = runner!.queryScopeViolationRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ judged: 'retroactive', target: 'evil.example', cleared: false })
      expect(rows[0].command).toContain('curl')

      await runner!.runScopeRecompute({
        before: scope(['*.target.com'], ['evil.example']), after: scope(['*.target.com', 'evil.example']), ...IDS
      })
      rows = runner!.queryScopeViolationRows()
      expect(rows[0].cleared).toBe(true)
      expect(runner!.countActiveScopeViolations()).toBe(0)
      expect(e).toBeTruthy()
    })

    it('returns the newest summary for the banner', async () => {
      expect(runner!.queryLastScopeRecompute()).toBeNull()
      shell('evil.example')
      await runner!.runScopeRecompute({
        before: scope(['*.target.com']), after: scope(['*.target.com'], ['evil.example']), ...IDS
      })
      const last = runner!.queryLastScopeRecompute()!
      expect(last).toMatchObject({ subtype: 'scope_recomputed', newly_flagged: 1 })
      expect(typeof last.id).toBe('string')
    })
  })
})
