import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isHookSource, isEvidence } from '../src/renderer/src/lib/housekeeping'
import type { RedLogEvent } from '../src/core/db/events'
import { initDB, closeDB } from '../src/core/db/index'
import { queryEventsPage } from '../src/core/db/events'
import { insertFixtureRow } from './helpers/timeline-query-fixture'

// Housekeeping is one rule, HOUSEKEEPING_SQL, applied where the rows are
// stored (spec 038). It used to be asked twice, once in JS for what was
// rendered and once in SQL for the pager, and two copies drift. These run the
// fixtures through the SQL itself.

let seq = 0
const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent => {
  seq += 1
  return {
    id: `e${seq}`, timestamp: seq, engagementId: 'e', sessionId: 's', operatorId: 'o',
    agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: seq
  }
}

const HOUSEKEEPING: RedLogEvent[] = [
  ev('system', { subtype: 'api_started' }),
  ev('system', { subtype: 'session_start' }),
  ev('shell', { subtype: 'session_start' }),
  ev('terminal', { subtype: 'session_start' }),
  ev('shell', { subtype: 'command_start', command: 'source /opt/redlog/shell-bash-hook.sh' }),
  ev('shell', { subtype: 'command_start', command: 'source /opt/redlog/shell-zsh-hook.zsh' }),
  ev('shell', { subtype: 'command_start', command: '. "C:\\Users\\op\\hooks\\shell-hook.ps1" *> $null; Clear-Host' }),
  ev('shell', { subtype: 'command', command: '. "C:\\Users\\op\\hooks\\shell-hook.ps1" *> $null; Clear-Host' }),
  ev('shell', { subtype: 'command_end', command: '. "C:\\Users\\op\\hooks\\shell-hook.ps1" *> $null; Clear-Host' })
]

const EVIDENCE: RedLogEvent[] = [
  ev('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' }),
  ev('shell', { subtype: 'command_end', command: 'nmap', exitCode: 0 }),
  ev('shell', { subtype: 'session_end', castPath: '/x.cast' }),
  ev('system', { subtype: 'ip_verdict', kind: 'unknown' }),
  ev('marker', { title: 'a finding' }),
  ev('dns', { subtype: 'dns_query', query_name: 'a.example' })
]

describe('housekeeping', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-housekeeping-'))
    initDB(dir)
    for (const e of [...HOUSEKEEPING, ...EVIDENCE]) {
      insertFixtureRow({
        table: 'events', id: e.id, timestamp: e.timestamp, agentType: e.agentType,
        subtype: String(e.data.subtype ?? ''), operatorId: 'o', targetId: null, data: e.data
      })
    }
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const kept = (): string[] => queryEventsPage({ excludeHousekeeping: true, limit: 100 }).items.map((e) => e.id)

  it('hides RedLog talking to itself', () => {
    const ids = kept()
    for (const e of HOUSEKEEPING) expect(ids, JSON.stringify(e.data)).not.toContain(e.id)
  })

  it('shows everything else, including the app-generated rows that ARE evidence', () => {
    // `system.ip_verdict` is a conclusion about the engagement, not plumbing —
    // which is why the visibility model needed a separate, positive predicate
    // rather than reusing this one.
    const ids = kept()
    for (const e of EVIDENCE) expect(ids, JSON.stringify(e.data)).toContain(e.id)
  })

  // The fixtures above store a missing subtype as ''. The ingest stores NULL
  // (event-write.ts), as for an event from the local API or a plugin, and in
  // SQL `NOT (subtype = 'session_start' OR …)` is then NULL, not true: the row
  // was dropped as though it were housekeeping. Once live rows were admitted by
  // this rule too (spec 038), such an event never appeared at all.
  it('keeps a row stored with no subtype, and a command row with no command', () => {
    const stored = [
      { id: 'n-shell', agentType: 'shell', subtype: null, data: { command: 'nmap -sV 10.0.0.5' } },
      { id: 'n-system', agentType: 'system', subtype: null, data: { note: 'posted by a tool' } },
      { id: 'n-terminal', agentType: 'terminal', subtype: null, data: { title: 'tab 2' } },
      { id: 'n-end', agentType: 'shell', subtype: 'command_end', data: { exitCode: 0 } }
    ]
    for (const [i, r] of stored.entries()) {
      insertFixtureRow({
        table: 'events', id: r.id, timestamp: 1000 + i, agentType: r.agentType,
        subtype: r.subtype as unknown as string, operatorId: 'o', targetId: null, data: r.data
      })
    }
    const ids = kept()
    for (const r of stored) expect(ids, r.id).toContain(r.id)
  })

  it('recognises the hook by its script name only', () => {
    expect(isHookSource('/x/shell-bash-hook.sh')).toBe(true)
    expect(isHookSource('/x/shell-zsh-hook.zsh')).toBe(true)
    expect(isHookSource('. "C:\\Users\\op\\hooks\\shell-hook.ps1" *> $null')).toBe(true)
    expect(isHookSource('curl https://example/shell-bash-hookXsh')).toBe(false)
    expect(isHookSource('shell-hook.ps2')).toBe(false)
    expect(isHookSource(undefined)).toBe(false)
  })

  it('separates "the app did this" from "the operator did this"', () => {
    // Strictly narrower than "not housekeeping", and the gap is what makes the
    // first-run screen possible: an IP verdict is a conclusion worth showing on
    // the timeline (the test above keeps it), and it lands within seconds of
    // opening any project.
    const verdict = ev('system', { subtype: 'ip_verdict', kind: 'unknown' })
    expect(isEvidence(verdict), 'a verdict is not the operator having done something').toBe(false)
    expect(isEvidence(ev('shell', { subtype: 'session_end', castPath: '/x' }))).toBe(false)
    expect(isEvidence(ev('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' }))).toBe(true)
    expect(isEvidence(ev('dns', { subtype: 'dns_query', query_name: 'a.example' }))).toBe(true)
    expect(isEvidence(ev('marker', { title: 'a finding' }))).toBe(true)
  })

  it('agrees with the SQL twin on every fixture', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../src/core/db/event-queries.ts'), 'utf-8')
    const block = sql.slice(sql.indexOf('const HOUSEKEEPING_SQL'), sql.indexOf('const HOUSEKEEPING_SQL') + 900)
    // Structural rather than a re-implementation: every rule the JS applies has
    // to be named in the SQL, or the pager and the view disagree about which
    // rows exist.
    for (const rule of ['api_started', 'session_start', 'shell-bash-hook.sh', 'shell-zsh-hook.zsh', 'shell-hook.ps1', 'command_start', 'command_end']) {
      expect(block, `SQL is missing the ${rule} rule`).toContain(rule)
    }
    expect(block).toContain("agent_type = 'terminal'")

    // The evidence predicate has a SQL twin too, and it is the one the
    // first-run screen and the sidebar both depend on.
    const evidence = sql.slice(sql.indexOf('export const EVIDENCE_SQL'), sql.indexOf('export const HTTP_FLOW_SUBTYPES'))
    expect(evidence).toContain("agent_type NOT IN ('system', 'cleanup')")
    expect(evidence).toContain('session_end')
    expect(evidence).toContain('shell-bash-hook.sh')
    expect(evidence).toContain('shell-zsh-hook.zsh')
    expect(evidence).toContain('shell-hook.ps1')
  })
})
