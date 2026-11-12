// Spec 071 T003 (US5): what POST /api/events answers today, case by case.
//
// Every installed hook, relay, proxy addon and plugin decides what to do with
// an event from this answer (test/legacy-producer-decisions.test.ts records
// how). Spec 071 adds /api/ingest beside it and promises the old route keeps
// answering old producers with exactly these codes, so this table is the
// contract the later phases are held to. It is a record of today, not an
// endorsement: several rows are the defects 01-capture-integrity.md F1 names,
// and are marked where they appear.
//
// Each row: what is set up, what is posted, the status, the exact body (or,
// for a 201, the shape of the row it echoes), and how many rows landed in the
// two tiers. Rows run in order against one server and one project; each one
// undoes its own setup.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { requires } from './helpers/requires'

// api-server.ts reads the global sidecar location from os.homedir() at module
// scope (same isolation as test/api-ingest-contract.test.ts).
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apihome-legacy-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

const sqlite = requires('better-sqlite3')
const listen = requires('listen')
const ready = sqlite.ok && listen.ok

let dbMod: typeof import('../src/core/db/index')
let api: typeof import('../src/core/api-server')
let ingest: typeof import('../src/core/ingest')
let bus: typeof import('../src/core/event-bus')
if (ready) {
  dbMod = await import('../src/core/db/index')
  api = await import('../src/core/api-server')
  ingest = await import('../src/core/ingest')
  bus = await import('../src/core/event-bus')
}

const ENG = 'eng-legacy'

interface Case {
  name: string
  /** F1 finding this row demonstrates, when it is a known defect. */
  finding?: string
  setup?: () => void
  teardown?: () => void
  /** Sent before the measured request, e.g. the first of two duplicates. */
  prime?: { agent_type: string; data: unknown }
  headers?: Record<string, string | null>
  body: string | Record<string, unknown>
  status: number
  /** Exact JSON body for everything but a 201. */
  json?: unknown
  /** For a 201: the echoed row's keys and the fields that are fixed. */
  row?: { keys: string[]; fields: Record<string, unknown> }
  /** Rows that landed: [chained, logged]. */
  landed: [number, number]
}

/** What a 201 echoes: the stored event minus rowId (api-server.ts withoutRowId). */
const CHAINED_ROW_KEYS = ['agentType', 'createdAt', 'data', 'engagementId', 'hash', 'hostname', 'id', 'monotonicNs', 'ntpOffsetMs',
  'operatorId', 'prevHash', 'sessionId', 'signature', 'sourceIP', 'targetId', 'tier', 'timestamp']
/** A logged row has no hash (undefined, so JSON drops it). */
const LOGGED_ROW_KEYS = CHAINED_ROW_KEYS.filter((k) => k !== 'hash')
const DUPLICATE = { error: 'Duplicate event (dedup window)' }

const CASES: Case[] = [
  {
    name: 'accepted: a shell command_start',
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 'leg-t1', pid: 101 } },
    status: 201,
    row: { keys: CHAINED_ROW_KEYS, fields: { agentType: 'shell', engagementId: ENG, operatorId: 'op-legacy', tier: 'chained' } },
    landed: [1, 0]
  },
  {
    name: 'accepted: a logged-tier scanner row',
    body: { agent_type: 'scanner', data: { subtype: 'http_request_start', flow_id: 'leg-f1', method: 'GET', url: 'http://h.test/' } },
    status: 201,
    row: { keys: LOGGED_ROW_KEYS, fields: { agentType: 'scanner', engagementId: ENG, operatorId: 'op-legacy', tier: 'logged', prevHash: null, signature: null } },
    landed: [0, 1]
  },
  {
    name: 'accepted: an operator marker',
    body: { agent_type: 'marker', data: { subtype: 'finding', title: 'x' } },
    status: 201,
    row: { keys: CHAINED_ROW_KEYS, fields: { agentType: 'marker', tier: 'chained' } },
    landed: [1, 0]
  },
  {
    name: 'heartbeat: system.producer_heartbeat with exactly subtype + producer',
    body: { agent_type: 'system', data: { subtype: 'producer_heartbeat', producer: 'pcap-capture' } },
    status: 201,
    row: { keys: CHAINED_ROW_KEYS, fields: { agentType: 'system', tier: 'chained' } },
    landed: [1, 0]
  },
  {
    name: '2 s dedup: the same command on the same terminal again',
    prime: { agent_type: 'shell', data: { subtype: 'command_start', command: 'whoami', terminalId: 'leg-t2', pid: 102 } },
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'whoami', terminalId: 'leg-t2', pid: 102 } },
    status: 409, json: DUPLICATE, landed: [0, 0]
  },
  {
    name: 'late-chunk dedup: the same command_id + seq of late output again',
    prime: { agent_type: 'shell', data: { subtype: 'command_output', late: true, command_id: 'leg-c1', seq: 1, stdout: 'x\n', bytes: 2 } },
    body: { agent_type: 'shell', data: { subtype: 'command_output', late: true, command_id: 'leg-c1', seq: 1, stdout: 'x\n', bytes: 2 } },
    status: 409, json: DUPLICATE, landed: [0, 0]
  },
  {
    name: 'cross-project inside ingest: the open database is bound to another engagement',
    finding: 'F1(a): a foreign-engagement refusal is answered with the dedup body',
    setup: () => dbMod.bindDBEngagement('eng-someone-else'),
    teardown: () => dbMod.bindDBEngagement(ENG),
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'hostname', terminalId: 'leg-t3', pid: 103 } },
    status: 409, json: DUPLICATE, landed: [0, 0]
  },
  {
    name: 'plumbing: RedLog\'s own adapter command',
    finding: 'F1: plumbing is answered with the dedup body',
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: '_redlog_prompt_command', terminalId: 'leg-t4', pid: 104 } },
    status: 409, json: DUPLICATE, landed: [0, 0]
  },
  {
    name: 'header pin: X-RedLog-Engagement names another engagement',
    headers: { 'X-RedLog-Engagement': 'eng-someone-else' },
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'pwd', terminalId: 'leg-t5', pid: 105 } },
    status: 409, json: { error: 'engagement changed; session capture refused' }, landed: [0, 0]
  },
  {
    name: 'captured identity: _identity.engagementId names another engagement',
    body: { agent_type: 'shell', _identity: { engagementId: 'eng-someone-else', operatorId: 'op-x' }, data: { subtype: 'command_start', command: 'pwd', terminalId: 'leg-t6', pid: 106 } },
    status: 409, json: { error: 'engagement changed; captured event refused' }, landed: [0, 0]
  },
  {
    name: 'paused: recording is paused',
    setup: () => bus.eventBus.pause('ui'),
    teardown: () => bus.eventBus.resume('ui'),
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'ls', terminalId: 'leg-t7', pid: 107 } },
    status: 200, json: { ok: true, recording: false, skipped: 'recording paused' }, landed: [0, 0]
  },
  {
    name: 'unrecorded: the terminal is not recording',
    setup: () => ingest.configureIngest({ terminalLifecycle: { prepare: () => false, recorded: () => undefined } }),
    teardown: () => ingest.configureIngest({ terminalLifecycle: null }),
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'ls -la', terminalId: 'leg-t8', pid: 108 } },
    status: 200, json: { ok: true, recording: false, skipped: 'terminal not recording' }, landed: [0, 0]
  },
  {
    name: 'policy 403: a system row other than the heartbeat',
    body: { agent_type: 'system', data: { subtype: 'recording_resumed' } },
    status: 403, json: { error: 'agent_type "system" is not allowed via external API' }, landed: [0, 0]
  },
  {
    name: 'policy 403: a heartbeat with one key too many',
    body: { agent_type: 'system', data: { subtype: 'producer_heartbeat', producer: 'pcap-capture', extra: 1 } },
    status: 403, json: { error: 'agent_type "system" is not allowed via external API' }, landed: [0, 0]
  },
  {
    name: 'policy 403: a derived kind (loot)',
    body: { agent_type: 'loot', data: { subtype: 'credential' } },
    status: 403, json: { error: 'agent_type "loot" is not allowed via external API' }, landed: [0, 0]
  },
  {
    name: 'marker 403: an amendment',
    body: { agent_type: 'marker', data: { subtype: 'amended', amends: 'x' } },
    status: 403, json: { error: 'marker amendments are written only from the app' }, landed: [0, 0]
  },
  {
    name: '400: not JSON',
    body: '{not json',
    status: 400, json: { error: 'invalid or empty JSON body' }, landed: [0, 0]
  },
  {
    name: '400: a JSON array',
    body: '[]',
    status: 400, json: { error: 'JSON body must be an object' }, landed: [0, 0]
  },
  {
    name: '400: data is not an object',
    body: { agent_type: 'shell', data: 'str' },
    status: 400, json: { error: 'data must be a JSON object' }, landed: [0, 0]
  },
  {
    name: '401: no bearer token',
    headers: { Authorization: null },
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'id' } },
    status: 401, json: { error: 'Unauthorized. Set Authorization: Bearer <token>' }, landed: [0, 0]
  },
  {
    name: '401: a token that is not this project\'s',
    // Assembled, so the source holds no credential-shaped literal.
    headers: { Authorization: ['Bearer', 'not-this-project'].join(' ') },
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'id' } },
    status: 401, json: { error: 'Unauthorized. Set Authorization: Bearer <token>' }, landed: [0, 0]
  },
  {
    name: '503: no project open',
    setup: () => api.onApiProjectClose(),
    teardown: () => api.onApiProjectOpen(),
    body: { agent_type: 'shell', data: { subtype: 'command_start', command: 'id' } },
    status: 503, json: { error: 'No project open. Open a project in the RedLog UI first.' }, landed: [0, 0]
  }
]

/** Skipped, with the reason printed by requires(), when either is absent. */
const describeApi = sqlite.ok ? listen.describe : sqlite.describe

describeApi('POST /api/events, as legacy producers see it', () => {
  let dir = ''
  let keys = ''
  let base = ''
  let token = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-api-legacy-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-api-legacy-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    api.configureApi({ engagementId: ENG, operatorId: 'op-legacy', operatorName: 'Legacy' })
    const port = await api.startApiServer(0)
    api.onApiProjectOpen()
    base = `http://127.0.0.1:${port}`
    token = api.getApiToken()
  })
  afterAll(async () => {
    api.stopApiServer()
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    for (const d of [dir, keys, FAKE_HOME]) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  const counts = (): [number, number] => [
    (dbMod.getDB().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    (dbMod.getDB().prepare('SELECT COUNT(*) AS n FROM events_logged').get() as { n: number }).n
  ]
  const post = (body: string | Record<string, unknown>, extra: Record<string, string | null> = {}): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    for (const [k, v] of Object.entries(extra)) { if (v === null) delete headers[k]; else headers[k] = v }
    return fetch(`${base}/api/events`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  }

  for (const c of CASES) {
    it(`${c.name} → ${c.status}`, async () => {
      if (c.prime) expect((await post(c.prime)).status, 'the primer must land').toBe(201)
      c.setup?.()
      let res: Response
      let before: [number, number]
      try {
        before = counts()
        res = await post(c.body, c.headers)
      } finally {
        c.teardown?.()
      }
      const after = counts()
      const body = await res.json() as Record<string, unknown>
      expect({ status: res.status, landed: [after[0] - before[0], after[1] - before[1]] }).toEqual({ status: c.status, landed: c.landed })
      if (c.row) {
        expect(Object.keys(body).sort()).toEqual(c.row.keys)
        expect(body).toMatchObject(c.row.fields)
      } else {
        expect(body).toEqual(c.json)
      }
    })
  }
})
