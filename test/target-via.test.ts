// Spec 071: every new row's stamp says how the row got its target_id
// (`_ingest.target_via`). Five values, decided in this order, first non-empty
// target wins:
//
//   explicit           the writer was handed a target (an API body's target_id,
//                      a spooled entry's, an in-process caller's)
//   operator-selected  the same step, for an in-app action that passes the
//                      operator's selected target; the in-process door only
//   extracted          the target extractor found a host in a shell command
//   command            a command_output chunk takes its command's target
//   none               target_id NULL
//
// There is no inheritance from the terminal and the global active target is no
// longer applied by ingest to anything.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { ENG, OP, interceptHttp, openRuntime, storedRows, type Item } from './helpers/ingest-delivery'
import { loadBuiltinTargetExtractors, unloadBuiltinTargetExtractors } from './helpers/builtin-extractors'

// api-server.ts reads and writes the machine-wide token under os.homedir(); a
// run must not touch the real one.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-target-via-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

const sqlite = requires('better-sqlite3')
let dbMod: typeof import('../src/core/db/index')
let ingestMod: typeof import('../src/core/ingest')
let stampMod: typeof import('../src/core/ingest/stamp')
if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  ingestMod = await import('../src/core/ingest')
  stampMod = await import('../src/core/ingest/stamp')
}

const who = { engagementId: ENG, operatorId: OP }
type Row = { table: string; agent: string; subtype: unknown; target: string | null; via: unknown; stamp: Record<string, unknown> }

function rowsOf(): Row[] {
  const db = dbMod.getDB()
  const out: Row[] = []
  for (const table of ['events', 'events_logged']) {
    for (const r of db.prepare(`SELECT agent_type, subtype, target_id, data FROM ${table} ORDER BY rowid`).all() as Array<{ agent_type: string; subtype: string | null; target_id: string | null; data: string }>) {
      const stamp = (JSON.parse(r.data) as { _ingest: Record<string, unknown> })._ingest
      out.push({ table, agent: r.agent_type, subtype: r.subtype, target: r.target_id, via: stamp.target_via, stamp })
    }
  }
  return out
}
const last = (agent: string, subtype?: string): Row => {
  const found = rowsOf().filter((r) => r.agent === agent && (subtype === undefined || r.subtype === subtype))
  return found[found.length - 1]
}

sqlite.describe('target_via', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-target-via-'))
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    loadBuiltinTargetExtractors()
  })
  afterEach(() => {
    unloadBuiltinTargetExtractors()
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const start = (command: string, extra: Record<string, unknown> = {}, targetId?: string) =>
    ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command, terminalId: 't1', pid: 11, ...extra }, ...who, ...(targetId ? { targetId } : {}) })

  describe('the five values', () => {
    it('explicit: the caller handed a target — and it beats a host in the command', () => {
      const ev = start('curl http://10.0.0.9/', {}, 'given.example').event!
      expect(ev.targetId).toBe('given.example')
      expect(last('shell').via).toBe('explicit')
      ingestMod.ingest({ agentType: 'marker', data: { subtype: 'created', title: 'm' }, targetId: 'given.example', ...who })
      expect(last('marker').via).toBe('explicit')
    })

    it('operator-selected: only the in-process door writes it', () => {
      ingestMod.ingest({ agentType: 'marker', data: { subtype: 'created', title: 'm' }, targetId: 'sel.example', targetVia: 'operator-selected', ...who })
      expect(last('marker')).toMatchObject({ target: 'sel.example', via: 'operator-selected' })
      // A legacy door that is handed the same claim records an explicit target.
      ingestMod.ingest({ agentType: 'marker', data: { subtype: 'created', title: 'm2' }, targetId: 'sel.example', targetVia: 'operator-selected', entrance: stampMod.LEGACY_API, ...who })
      expect(last('marker').via).toBe('explicit')
      ingestMod.ingest({ agentType: 'marker', data: { subtype: 'created', title: 'm3' }, targetId: 'sel.example', targetVia: 'operator-selected', entrance: stampMod.LEGACY_HANDOFF, ...who })
      expect(last('marker').via).toBe('explicit')
    })

    it('extracted: a host in a shell command', () => {
      start('curl http://10.0.0.9/')
      expect(last('shell')).toMatchObject({ target: '10.0.0.9', via: 'extracted' })
    })

    it('command: a chunk takes the target its command was filed under; of a command without one it is none', () => {
      start('nmap -sV 10.0.0.5 &', { command_id: 'C1' })
      ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_end', command: 'nmap -sV 10.0.0.5 &', terminalId: 't1', pid: 11, command_id: 'C1', exit_code: 0, late_output: true }, ...who })
      start('sleep 30 &', { command_id: 'C2', pid: 12 })
      ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_end', command: 'sleep 30 &', terminalId: 't1', pid: 12, command_id: 'C2', exit_code: 0, late_output: true }, ...who })
      const chunk = (id: string, seq: number, final = false) =>
        ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_output', command_id: id, late: true, seq, stdout: 'x\n', final, captured_by: 'redlog-relay' }, ...who })
      chunk('C1', 0)
      expect(last('shell', 'command_output')).toMatchObject({ target: '10.0.0.5', via: 'command' })
      chunk('C2', 0)
      expect(last('shell', 'command_output')).toMatchObject({ target: null, via: 'none' })
      chunk('C1', 1, true)
      expect(last('shell', 'command_output')).toMatchObject({ target: '10.0.0.5', via: 'command' })
      chunk('C1', 2) // after the final row: it belongs to no command
      expect(last('shell', 'command_output')).toMatchObject({ target: null, via: 'none' })
    })

    it('none: a host-less command with an engagement target configured is NULL, and so is the next one on the same terminal after nmap', () => {
      // The option ingest used to take; it is gone, and nothing replaces it.
      ;(ingestMod.configureIngest as (o: object) => void)({ activeTarget: '10.10.11.24' })
      const id = start('id').event!
      expect(id.targetId).toBeNull()
      expect(last('shell')).toMatchObject({ target: null, via: 'none' })
      start('nmap -sV 10.0.0.5')
      expect(last('shell').via).toBe('extracted')
      start('whoami')
      expect(last('shell')).toMatchObject({ target: null, via: 'none' })
    })

    it('rows that used the global target are none now: markers, screenshots, files', () => {
      ;(ingestMod.configureIngest as (o: object) => void)({ activeTarget: '10.10.11.24' })
      ingestMod.ingest({ agentType: 'marker', data: { subtype: 'created', title: 'm' }, ...who })
      ingestMod.ingest({ agentType: 'screenshot', data: { trigger: 'timed', filename: 's.jpg' }, ...who })
      ingestMod.ingest({ agentType: 'file_transfer', data: { subtype: 'artifact_added', source: 'operator', path: '/tmp/a', stored: 'artifacts/a', sha256: 'aa', size: 1, mtime: 1 }, ...who })
      for (const agent of ['marker', 'screenshot', 'file_transfer']) expect(last(agent), agent).toMatchObject({ target: null, via: 'none' })
    })
  })

  describe('where the key sits', () => {
    it('after terminal and before claimed, in both tables', () => {
      start('curl http://10.0.0.9/')
      ingestMod.ingest({ agentType: 'scanner', data: { subtype: 'http_request_start', host: 'a.example', url: 'https://a.example/' }, ...who })
      const keys = (r: Row): string[] => Object.keys(r.stamp)
      const chained = rowsOf().find((r) => r.table === 'events' && r.agent === 'shell')!
      const logged = rowsOf().find((r) => r.table === 'events_logged')!
      expect(keys(chained)).toEqual(['v', 'door', 'producer', 'credential', 'auth', 'event_id', 'terminal', 'target_via'])
      expect(keys(logged)).toEqual(['v', 'door', 'producer', 'credential', 'auth', 'event_id', 'target_via'])
      const s = stampMod.ingestStamp(stampMod.IN_PROCESS, {
        tier: 'chained', now: 1, terminal: 't', targetVia: 'none', stripped: ['_ingest'], collapsed: 1,
        item: { instance: 'i', seq: 1, claimed: { producer: 'p', operator: 'o' }, rules: [{ pluginId: 'p', contentHash: 'h' }], rulesPartial: true }
      })
      expect(Object.keys(s)).toEqual(['v', 'door', 'producer', 'credential', 'auth', 'event_id', 'instance', 'seq', 'terminal', 'target_via', 'claimed', 'stripped', 'collapsed', 'rules', 'rules_partial'])
    })
  })

  describe('derived rows', () => {
    it('take their source row\'s target and via; a host the detector names is explicit', () => {
      const r = start('curl -o /tmp/x http://10.0.0.5/a.sh')
      const xfer = r.companions.find((c) => c.agentType === 'file_transfer')!
      expect(xfer.targetId).toBe('10.0.0.5')
      expect(last('file_transfer').via).toBe('extracted')
      start('sshuttle -r user@jump 10.10.0.0/16', { pid: 12 })
      expect(last('pivot')).toMatchObject({ target: 'jump', via: 'explicit' })
      // Given a target by its writer, the file transfer inherits `explicit`.
      start('curl -o /tmp/y http://10.0.0.6/b.sh', { pid: 13 }, 'given.example')
      expect(last('file_transfer')).toMatchObject({ target: 'given.example', via: 'explicit' })
      // ...and an operator-selected source gives an operator-selected companion.
      ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'curl -o /tmp/z http://10.0.0.6/c.sh', pid: 14 }, targetId: 'sel.example', targetVia: 'operator-selected', ...who })
      expect(last('file_transfer')).toMatchObject({ target: 'sel.example', via: 'operator-selected' })
    })

    it('loot from a row takes that row\'s target and via', async () => {
      const { LootDetector } = await import('../src/core/loot-detector')
      const loot = new LootDetector()
      loot.configure({ identity: { projectId: 'p', engagementId: ENG, operatorId: OP } })
      ingestMod.configureIngest({ lootDetector: loot })
      const secret = ['pass', 'word', '='].join('') + ['Sup3r', 'S3cret', 'Value!'].join('')
      ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_end', command: 'curl http://10.0.0.5/creds', terminalId: 't1', pid: 15, exit_code: 0, stdout: secret + '\n' }, ...who })
      expect(last('loot')).toMatchObject({ target: '10.0.0.5', via: 'extracted' })
    })
  })
})

// Through the doors that are not in-process: a body that claims the receiver's
// own words is not believed.
sqlite.describe('target_via through the API and the spool', () => {
  let dir = ''
  beforeEach(() => { interceptHttp(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-target-via-doors-')) })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
  const forged = (item: Item): Item => ({
    ...item, ...({ target_via: 'operator-selected', targetVia: 'operator-selected' } as object),
    data: { ...item.data, _ingest: { target_via: 'operator-selected' }, target_via: 'operator-selected' }
  })

  it('a legacy API body\'s target is explicit, and a claim of operator-selected is not believed', async () => {
    const rt = await openRuntime(dir)
    try {
      await rt.api(forged({ agent_type: 'marker', target_id: 'given.example', data: { subtype: 'created', title: 'm' } }))
      await rt.api({ agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't9', pid: 9 } })
      await rt.api({ agent_type: 'shell', data: { subtype: 'command_start', command: 'curl http://10.0.0.9/', terminalId: 't9', pid: 10 } })
    } finally { await rt.close() }
    const rows = (await storedRows(dir)).map((r) => ({ k: `${r.row.agent_type}`, t: r.row.target_id, v: (r.data._ingest as Record<string, unknown>).target_via, door: (r.data._ingest as Record<string, unknown>).door }))
    expect(rows.filter((r) => r.door === 'legacy-api')).toEqual([
      { k: 'marker', t: 'given.example', v: 'explicit', door: 'legacy-api' },
      { k: 'shell', t: null, v: 'none', door: 'legacy-api' },
      { k: 'shell', t: '10.0.0.9', v: 'extracted', door: 'legacy-api' }
    ])
  })

  it('a spooled entry\'s target is explicit, and a claim of operator-selected is not believed', async () => {
    const rt = await openRuntime(dir)
    try {
      rt.spool([forged({ agent_type: 'scanner', target_id: 'given.example', data: { subtype: 'http_request_start', host: 'a.example', url: 'https://a.example/' } }),
        { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't9', pid: 9 } }], path.join(dir, 'spool'))
    } finally { await rt.close() }
    const rows = (await storedRows(dir)).filter((r) => (r.data._ingest as Record<string, unknown>).door === 'legacy-handoff')
      .map((r) => [r.row.agent_type, r.row.target_id, (r.data._ingest as Record<string, unknown>).target_via])
    expect(rows).toEqual([['shell', null, 'none'], ['scanner', 'given.example', 'explicit']]) // chained tier, then logged
  })
})
