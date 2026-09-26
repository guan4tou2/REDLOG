import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// ingest() is the single path every event takes into the record (docs/
// DESIGN-plugin-kernel.md §3). These tests prove the two properties that make
// "one path" safe: enrichment runs once and only for primary rows, and the
// envelope's raw bytes are attested by the chain (their digest is inside the
// hashed data). DB-backed, so it rides the native-module guard.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let ingestMod: typeof import('../src/core/ingest')
let events: typeof import('../src/core/db/events')
let raw: typeof import('../src/core/raw-store')
let chain: typeof import('../src/core/chain-anchor')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  ingestMod = await import('../src/core/ingest')
  events = await import('../src/core/db/events')
  raw = await import('../src/core/raw-store')
  chain = await import('../src/core/chain-anchor')
  ops = await import('../src/core/db/operators')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('ingest', () => {
  let tmpDir: string
  let opId: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ingest-'))
    initDB(tmpDir)
    opId = ops.ensurePrimaryOperator('op-primary', 'Primary', ops.generateToken()).id
  })
  afterAll(() => {
    try { closeDB() } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  })
  afterEach(() => ingestMod._resetIngest())

  const base = { operatorId: '', engagementId: 'eng-1' }
  beforeAll(() => { base.operatorId = opId })

  // #182 — the capture browser opened, the operator navigated nowhere, and
  // three `credential_use` rows tagged T1078 (MITRE Valid Accounts) landed in
  // the CHAINED tier: the layer that reaches the client in `events.jsonl`.
  // They were Chrome registering itself for push, which a brand-new profile
  // does on its own. Read by a client, they said the operator used valid
  // accounts against Google during the engagement.
  const httpReq = (headers: [string, string][], host = 'target.example') => ({
    ...base, agentType: 'scanner',
    data: {
      subtype: 'http_request_start', host, url: `https://${host}/`,
      request_headers: headers
    }
  })
  const creds = (r: { companions: Array<{ agentType: string; data: Record<string, unknown> }> }) =>
    r.companions.filter((c) => c.agentType === 'credential_use')

  it('does not claim valid-account use from an Authorization scheme it cannot name', () => {
    const r = ingestMod.ingest(httpReq(
      [['Authorization', 'AidLogin aidtoken']], 'android.clients.google.com'
    ))
    expect(creds(r)).toHaveLength(0)
  })

  it('still records the auth schemes it can name', () => {
    for (const [header, method] of [
      ['Basic dXNlcjpwdw==', 'basic_auth'],
      ['Bearer eyJhbGciOi', 'bearer_token'],
      ['NTLM TlRMTVNTUA==', 'ntlm'],
      ['Negotiate YIIF', 'negotiate'],
      ['Digest username="admin"', 'digest']
    ] as const) {
      const r = ingestMod.ingest(httpReq([['Authorization', header]]))
      const found = creds(r)
      expect({ header, n: found.length }).toEqual({ header, n: 1 })
      expect(found[0].data).toMatchObject({ subtype: method, mitre_ttp: 'T1078' })
    }
  })

  it('an unnameable Authorization header does not fall through to the weaker heuristics', () => {
    // The request carried an Authorization header, so a `session_cookie` or
    // `api_key` verdict from the headers beside it would describe the same
    // request less accurately, not more.
    const r = ingestMod.ingest(httpReq([
      ['Authorization', 'AidLogin aidtoken'],
      ['Cookie', 'session=abc123'],
      ['X-API-Key', 'k'.repeat(20)]
    ], 'android.clients.google.com'))
    expect(creds(r)).toHaveLength(0)
  })

  it('a shell command_start derives its companion pivot exactly once', () => {
    const r = ingestMod.ingest({
      ...base, agentType: 'shell',
      data: { subtype: 'command_start', command: 'ssh -D 1080 user@10.0.0.9', terminal_id: 't1', pid: 123 }
    })
    expect(r.event).not.toBeNull()
    // one pivot companion, and it cites the shell row
    const pivots = r.companions.filter((c) => c.agentType === 'pivot')
    expect(pivots).toHaveLength(1)
    expect((pivots[0].data._causes as string[])[0]).toBe(r.event!.id)
    // the companion itself did NOT spawn a pivot-of-a-pivot
    const secondPass = ingestMod.ingest({
      ...base, agentType: 'pivot', derived: true,
      data: { subtype: 'socks_up', tool: 'ssh', command: 'ssh -D 1080 user@10.0.0.9' }
    })
    expect(secondPass.companions).toHaveLength(0)
  })

  it('the migration helper publishes one primary event and keeps canonical enrichment', async () => {
    const { eventBus } = await import('../src/core/event-bus')
    const received: Array<{ id: string }> = []
    const listener = (event: { id: string }): void => { received.push(event) }
    eventBus.on('event', listener)
    try {
      const event = ingestMod.ingestEvent('shell', {
        subtype: 'command_start', command: 'curl https://10.0.0.37/status', terminal_id: 'migration-test', pid: 37
      }, base)
      await new Promise(resolve => queueMicrotask(resolve))

      expect(event).not.toBeNull()
      expect(event!.data.detectedTarget).toBe('10.0.0.37')
      expect(received.filter((candidate) => candidate.id === event!.id)).toHaveLength(1)
    } finally {
      eventBus.off('event', listener)
    }
  })

  it('uses active target only when producer and enrichment have no target', () => {
    ingestMod.configureIngest({ activeTarget: '10.10.11.24' })
    const fallback = ingestMod.ingest({
      ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'id' }
    }).event!
    const detected = ingestMod.ingest({
      ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'curl http://10.10.11.99/' }
    }).event!
    const explicit = ingestMod.ingest({
      ...base, agentType: 'marker', targetId: 'manual.example', data: { subtype: 'created', title: 'manual' }
    }).event!
    const screenshot = ingestMod.ingest({
      ...base, agentType: 'screenshot', data: { trigger: 'manual', filename: 'shot.jpg' }
    }).event!
    const system = ingestMod.ingest({
      ...base, agentType: 'system', data: { subtype: 'capture_health' }
    }).event!

    expect(fallback.targetId).toBe('10.10.11.24')
    expect(detected.targetId).toBe('10.10.11.99')
    expect(explicit.targetId).toBe('manual.example')
    expect(screenshot.targetId).toBe('10.10.11.24')
    expect(system.targetId).toBeNull()
  })

  it('clearing active target stops fallback attribution', () => {
    ingestMod.configureIngest({ activeTarget: '10.10.11.24' })
    ingestMod.configureIngest({ activeTarget: null })
    const event = ingestMod.ingest({
      ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'whoami' }
    }).event!
    expect(event.targetId).toBeNull()
  })

  it('stores cwd correlation as candidates without changing explicit causes', () => {
    const command = ingestMod.ingest({
      ...base, agentType: 'shell',
      data: { subtype: 'command_start', command: 'nmap -oA loot/scan 10.0.0.9', terminalId: 'artifact-t1', pid: 81, cwd: '/work' }
    }).event!
    const file = ingestMod.ingest({
      ...base, agentType: 'file_transfer',
      data: {
        subtype: 'file_created', source: 'file-watcher', path: '/work/loot/scan.xml',
        _causes: ['evt-explicit']
      }
    }).event!

    expect(file.data._causes).toEqual(['evt-explicit'])
    expect(file.data.related_commands).toEqual([{
      event_id: command.id, method: 'cwd-overlap', state: 'active'
    }])
  })

  it('settles a command end while paused before later file correlation', async () => {
    const { eventBus } = await import('../src/core/event-bus')
    const commandData = { command: 'tool -o loot/out', terminalId: 'paused-t1', pid: 82, cwd: '/work' }
    const command = ingestMod.ingest({
      ...base, agentType: 'shell', data: { subtype: 'command_start', ...commandData }
    }).event!
    eventBus.pause('api')
    try {
      const end = ingestMod.ingest({
        ...base, agentType: 'shell', data: { subtype: 'command_end', ...commandData }
      })
      expect(end.skipped).toBe('paused')
    } finally {
      eventBus.resume('api')
    }
    const file = ingestMod.ingest({
      ...base, agentType: 'file_transfer',
      data: { subtype: 'file_created', source: 'file-watcher', path: '/work/loot/out' }
    }).event!
    expect(file.data.related_commands).toEqual([{
      event_id: command.id, method: 'cwd-near-command-end', state: 'recent'
    }])
  })

  it('stores the raw bytes and folds their digest into the hashed data', () => {
    const rawBytes = Buffer.from(JSON.stringify({ agent_type: 'scanner', host: '10.0.0.9', port: 445 }))
    const r = ingestMod.ingest({
      ...base, agentType: 'scanner',
      data: { subtype: 'connection', proto: 'tcp', remote_addr: '10.0.0.9', remote_port: 445 },
      envelope: { raw: rawBytes, source: 'connection-monitor', mapper: { id: 'identity', version: '1' } }
    })
    expect(r.event).not.toBeNull()
    const stored = r.event!.data._raw as { sha256: string } | undefined
    expect(stored).toBeDefined()
    // the digest recorded in data equals the sha256 of the bytes we sent
    expect(stored!.sha256).toBe(crypto.createHash('sha256').update(rawBytes).digest('hex'))
    // and the bytes are readable back, unchanged, from the raw store
    expect(raw.isRawRef(stored)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(raw.readRaw(stored as any)!.equals(rawBytes)).toBe(true)
  })

  it('the chain still verifies after envelope rows land (raw digest is inside the hash)', async () => {
    const res = await chain.verifyChainFullAsync()
    expect(res.ok, res.brokenReason ?? '').toBe(true)
  })

  it('a paused recording writes nothing and derives nothing', async () => {
    const { eventBus } = await import('../src/core/event-bus')
    eventBus.pause('api')
    try {
      const r = ingestMod.ingest({
        ...base, agentType: 'shell',
        data: { subtype: 'command_start', command: 'nmap 10.0.0.9', terminal_id: 't2', pid: 9 }
      })
      expect(r.event).toBeNull()
      expect(r.skipped).toBe('paused')
      expect(r.companions).toHaveLength(0)
    } finally {
      eventBus.resume('api')
    }
  })
})
