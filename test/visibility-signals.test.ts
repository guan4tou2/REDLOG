import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isEvidence } from '../src/renderer/src/lib/housekeeping'
import type { RedLogEvent } from '../src/core/db/events'

// The main-process half of the two surviving signals. The pure model is tested
// in visibility.test.ts; what only a database can settle is whether
// `evidenceSeen` really means the operator did something, rather than the app
// talking to itself — every case here is one where the obvious query dismissed
// the first-run screen within seconds of creating a project.
//
// The nine other signals are gone with the page hiding they fed, and so are
// their cases.

let events: typeof import('../src/core/db/events') | null = null
let dbmod: typeof import('../src/core/db/index') | null = null
let vis: typeof import('../src/core/visibility-signals') | null = null
let findings: typeof import('../src/core/db/bookmarks') | null = null
try {
  const D = (await import('better-sqlite3')).default
  new D(':memory:').close()
  events = await import('../src/core/db/events')
  dbmod = await import('../src/core/db/index')
  vis = await import('../src/core/visibility-signals')
  findings = await import('../src/core/db/bookmarks')
} catch { /* better-sqlite3 not built for this Node ABI */ }

const available = events !== null
const IDS = { engagementId: 'eng', operatorId: 'op' }
const asEvent = (agentType: string, data: Record<string, unknown>): RedLogEvent => ({
  id: 'e1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: 1
})

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

  it('a virgin project has nothing to report', () => {
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
      ins('shell', { subtype: 'command_start', command: '/x/shell-bash-hook.sh install' })
      expect(sig().evidenceSeen).toBe(false)
    })

    it('counts a real command', () => {
      ins('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' })
      expect(sig().evidenceSeen).toBe(true)
    })

    // The ingest stores a missing data.subtype as NULL (event-write.ts), as for
    // an event from the local API or a plugin, and in SQL `NOT (subtype IN
    // (…))` is then NULL rather than true: the row was not evidence, and the
    // first-run screen stayed up after the operator had run something. Same for
    // a command row with no `command`, through the hook-source LIKEs. The
    // renderer's twin, isEvidence, already counted both.
    it('counts a command stored with no subtype', () => {
      const data = { command: 'nmap -sV 10.0.0.5' }
      ins('shell', data)
      expect(sig().evidenceSeen).toBe(true)
      expect(isEvidence(asEvent('shell', data))).toBe(true)
    })

    it('counts a command row with no command', () => {
      const data = { subtype: 'command_end', exit_code: 0 }
      ins('shell', data)
      expect(sig().evidenceSeen).toBe(true)
      expect(isEvidence(asEvent('shell', data))).toBe(true)
    })

    it('counts anything in the logged tier — that table holds only capture', () => {
      ins('dns', { subtype: 'dns_query', query_name: 'a.example' })
      expect(sig().evidenceSeen).toBe(true)
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
      ins('shell', { subtype: 'command_start', command: 'nmap 10.0.0.1' })
      expect(sig().evidenceSeen).toBe(true)
      vis!.resetVisibilitySignalsCache()
      dbmod!.closeDB()
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vis2-'))
      dbmod!.initDB(other)
      expect(sig().evidenceSeen, 'a flag leaked across projects').toBe(false)
      dbmod!.closeDB()
      fs.rmSync(other, { recursive: true, force: true })
      dbmod!.initDB(dir)
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
