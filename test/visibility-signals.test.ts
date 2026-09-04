import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// docs/UIUX-STANDARD.md §22, the main-process half. The pure model is tested in
// visibility.test.ts; what only a database can settle is whether each signal
// actually means what its noun claims — every case here is one where the
// obvious query would have unlocked a page onto an empty screen, or unlocked it
// with no operator action at all.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let vis: typeof import('../src/core/visibility-signals') | null = null
let findings: typeof import('../src/core/db/findings') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  vis = await import('../src/core/visibility-signals')
  findings = await import('../src/core/db/findings')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = events !== null
const IDS = { engagementId: 'eng', operatorId: 'op' }

describe.skipIf(!available)('visibility signals', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vis-'))
    dbmod!.initDB(dir)
    vis!.resetVisibilitySignalsCache()
  })
  afterEach(() => {
    dbmod!.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const sig = (): import('../src/core/visibility-signals').VisibilitySignals => vis!.getVisibilitySignals()
  const ins = (agentType: string, data: Record<string, unknown>, targetId?: string): void => {
    events!.insertEvent(agentType, data, { ...IDS, ...(targetId ? { targetId } : {}) })
  }

  it('a virgin project has nothing to disclose', () => {
    expect(sig()).toEqual(vis!.EMPTY_VISIBILITY_SIGNALS)
  })

  describe('evidence — what counts as the operator having done something', () => {
    it('does not count the app talking to itself', () => {
      // These all land on a project nobody has touched. The alert runtime
      // starts on every open and the IP policy emits its first verdict
      // unconditionally, so an "any non-housekeeping row" test would dismiss
      // the first-run screen within seconds of creating a project.
      ins('system', { subtype: 'ip_verdict', kind: 'unknown' })
      ins('system', { subtype: 'session_start' })
      ins('system', { subtype: 'api_started' })
      ins('shell', { subtype: 'session_start' })
      ins('shell', { subtype: 'session_end' })
      ins('shell', { subtype: 'command_start', command: '/x/shell-preexec-hook.sh install' })
      expect(sig().evidenceSeen).toBe(false)
    })

    it('counts a real command', () => {
      ins('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' })
      expect(sig().evidenceSeen).toBe(true)
    })

    it('counts anything in the logged tier — that table holds only capture', () => {
      ins('dns', { subtype: 'dns_query', query_name: 'a.example' })
      expect(sig().evidenceSeen).toBe(true)
    })
  })

  describe('目標 and 範圍', () => {
    it('count only targets a COMMAND produced', () => {
      // The proxy addon stamps a target on every HTTP flow and DNS query, and
      // the connection monitor on every established socket. Counting targets
      // across all types would unlock both pages from one browser page load
      // with no command typed.
      ins('scanner', { subtype: 'http_request_start', host: 'a.example' }, 'a.example')
      ins('dns', { subtype: 'dns_query', query_name: 'b.example' }, 'b.example')
      ins('scanner', { subtype: 'connection', remoteAddr: '10.0.0.9' }, '10.0.0.9')
      expect(sig().targetCount).toBe(0)
    })

    it('reach one and then two as commands hit distinct hosts', () => {
      ins('shell', { subtype: 'command_start', command: 'curl a' }, 'a.example')
      expect(sig().targetCount).toBe(1)
      vis!.resetVisibilitySignalsCache()
      ins('shell', { subtype: 'command_start', command: 'curl a again' }, 'a.example')
      expect(sig().targetCount, 'the same host twice is one target').toBe(1)
      vis!.resetVisibilitySignalsCache()
      ins('shell', { subtype: 'command_start', command: 'curl b' }, 'b.example')
      expect(sig().targetCount).toBe(2)
    })

    it('cap at two — the only two answers that matter', () => {
      for (const h of ['a', 'b', 'c', 'd']) ins('shell', { subtype: 'command_start', command: `curl ${h}` }, `${h}.example`)
      expect(sig().targetCount).toBe(2)
    })
  })

  describe('每個名詞等的是它自己那一頁的資料', () => {
    it('HTTP waits for a logged flow, not for any scanner row', () => {
      // The HTTP page queries the logged tier and the http_* subtypes. A
      // chained `scanner:connection` from the connection monitor would unlock
      // a permanently empty page.
      ins('scanner', { subtype: 'connection', remoteAddr: '10.0.0.9' })
      expect(sig().httpFlowSeen).toBe(false)
      vis!.resetVisibilitySignalsCache()
      ins('scanner', { subtype: 'http_request_start', host: 'a.example', method: 'GET' })
      expect(sig().httpFlowSeen).toBe(true)
    })

    it('書籤 waits for a bookmark row, not for a marker event', () => {
      // Two different stores. The page lists only the table — and `marker` is
      // externally postable, so keying on the event would let an outside tool
      // unlock an empty page.
      ins('marker', { title: 'a finding', severity: 'info' })
      expect(sig().bookmarkSeen).toBe(false)
      vis!.resetVisibilitySignalsCache()
      findings!.createQuickMark({ title: 'bookmark', url: 'https://x', note: '' })
      expect(sig().bookmarkSeen).toBe(true)
    })

    it('逐字稿 waits for a finished command or an agent turn', () => {
      ins('shell', { subtype: 'command_start', command: 'sleep 60' })
      expect(sig().transcriptSeen).toBe(false)
      vis!.resetVisibilitySignalsCache()
      ins('shell', { subtype: 'command_end', command: 'sleep 60', exitCode: 0 })
      expect(sig().transcriptSeen).toBe(true)
    })

    it('戰利品 and 截圖 wait for their own chained rows', () => {
      ins('loot', { subtype: 'credential_detected', count: 1 })
      ins('screenshot', { trigger: 'manual', filename: 'a.jpg' })
      const s = sig()
      expect(s.lootSeen).toBe(true)
      expect(s.screenshotSeen).toBe(true)
    })
  })

  describe('the tier distinction', () => {
    it('appears with the first logged row', () => {
      expect(sig().loggedEver).toBe(false)
      vis!.resetVisibilitySignalsCache()
      ins('dns', { subtype: 'dns_query', query_name: 'a.example' })
      expect(sig().loggedEver).toBe(true)
    })

    it('survives a total prune of the logged tier', () => {
      // The audit row outlives what it describes, so a project whose logged
      // rows have all aged out still knows it had them — otherwise the chip
      // would vanish and the operator would read that as the tier itself
      // having gone away.
      ins('dns', { subtype: 'dns_query', query_name: 'a.example' })
      ins('system', { subtype: 'retention_pruned_logged', deleted: 1 })
      dbmod!.getDB().prepare('DELETE FROM events_logged').run()
      vis!.resetVisibilitySignalsCache()
      expect(sig().loggedEver).toBe(true)
    })
  })

  describe('the cache', () => {
    it('never lowers a flag once raised', () => {
      ins('shell', { subtype: 'command_start', command: 'curl a' }, 'a.example')
      expect(sig().evidenceSeen).toBe(true)
      dbmod!.getDB().prepare("DELETE FROM events WHERE agent_type = 'shell'")
      // Chained rows cannot actually be deleted; the point is that the second
      // call does not re-probe at all.
      expect(sig().evidenceSeen).toBe(true)
    })

    it('starts clean for the next project', () => {
      ins('loot', { subtype: 'credential_detected' })
      expect(sig().lootSeen).toBe(true)
      vis!.resetVisibilitySignalsCache()
      dbmod!.closeDB()
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vis2-'))
      dbmod!.initDB(other)
      expect(sig().lootSeen, 'a flag leaked across projects').toBe(false)
      dbmod!.closeDB()
      fs.rmSync(other, { recursive: true, force: true })
      dbmod!.initDB(dir)
    })
  })

  describe('cost', () => {
    it('answers the target question with index seeks, not a scan', () => {
      const plan = (sql: string, ...p: unknown[]): string =>
        (dbmod!.getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as Array<{ detail: string }>)
          .map((r) => r.detail).join(' | ')
      const detail = plan(
        `SELECT target_id AS t FROM events
         WHERE agent_type = 'shell' AND target_id IS NOT NULL AND target_id <> ''
         ORDER BY target_id LIMIT 1`
      )
      expect(detail).not.toContain('SCAN events')
      expect(detail, 'a temp b-tree here means the whole bucket was sorted').not.toContain('TEMP B-TREE')
    })
  })
})

describe('the two signal shapes are the same shape', () => {
  it('main and renderer declare identical fields', () => {
    // The bundles share no module graph, so the interface is written twice.
    // Nothing typechecks across that boundary — this reads both sources.
    const fields = (file: string): string[] => {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf-8')
      const body = src.slice(src.indexOf('interface VisibilitySignals'))
      return [...body.slice(0, body.indexOf('}')).matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]).sort()
    }
    expect(fields('src/core/visibility-signals.ts'))
      .toEqual(fields('src/renderer/src/lib/visibility.ts'))
  })
})
