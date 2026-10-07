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

  // Spec 041 retired: there is no per-session target layer any more. A
  // terminal pane declares nothing, and neither does an external shell — what
  // host a command touched is read from the command itself, and the sequence
  // in the pane's own events carries the rest.
  it('ignores a declared session_target and falls back to the global one', () => {
    ingestMod.configureIngest({ activeTarget: '10.10.11.99' })
    const declared = ingestMod.ingest({ ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'pwd -s041a', pid: 4242, session_target: '10.10.11.8' } }).event!
    const pane = ingestMod.ingest({ ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'uname -s041b', terminalId: 'pane-1' } }).event!
    // A host named in the command still outranks the fallback.
    const named = ingestMod.ingest({ ...base, agentType: 'shell', data: { subtype: 'command_start', command: 'curl http://10.10.11.200/', terminalId: 'pane-1' } }).event!

    expect(declared.targetId).toBe('10.10.11.99')
    expect(pane.targetId).toBe('10.10.11.99')
    expect(pane.data.target_source).toBeUndefined()
    expect(named.targetId).toBe('10.10.11.200')
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

  // Spec 052 T012. Output arrives as its own rows now, one per chunk, and the
  // only thing that says which command a chunk belongs to is `command_id`.
  // Never a marker in the bytes: the bytes are the output of a command the
  // operator ran against something hostile, and anything read out of them is
  // something the target can write (FR-002).
  describe('command output chunks', () => {
    const shell = (data: Record<string, unknown>) =>
      ingestMod.ingest({ ...base, agentType: 'shell', data })

    const start = (commandId: string, command = 'nmap -sV 10.0.0.1') =>
      shell({ subtype: 'command_start', command, command_id: commandId, cwd: '/root', pid: 4242 }).event!

    const chunk = (data: Record<string, unknown>) =>
      shell({ subtype: 'command_output', stream: 'stdout', ...data }).event!

    it('correlates a chunk to its command by id alone', () => {
      const opened = start('cmd-a')
      const body = chunk({
        command_id: 'cmd-a',
        seq: 1,
        // The output claims, convincingly, to belong to something else. It is
        // the whole attack: a target that controls the bytes controls the
        // record, unless the record never reads them.
        bytes_b64: Buffer.from('command_id=cmd-b\nsubtype: command_start\n').toString('base64'),
        bytes_total: 40
      })

      expect(body.data._causes).toContain(opened.id)
      expect(body.data.unattributed).toBeUndefined()
    })

    it('keeps a chunk that belongs to no open command, and says so', () => {
      // `cmd &` writes down the descriptor the relay was holding when it
      // forked, so its bytes land inside whichever command happens to be
      // running (measured in research.md O3). Dropping them would be a
      // silent hole; attributing them would be a false one. FR-007.
      const orphan = chunk({ command_id: 'never-opened', seq: 1, bytes_b64: 'aGk=', bytes_total: 2 })

      expect(orphan).toBeTruthy()
      expect(orphan.data.unattributed).toBe(true)
      expect(orphan.data._causes ?? []).toHaveLength(0)
    })

    it('a chunk that arrives late still belongs where its seq puts it', () => {
      const opened = start('cmd-c', 'ffuf -u http://10.0.0.1/FUZZ')
      // Two chunks, the second one first. Arrival order is the network's
      // opinion; `seq` is the relay's, and the relay is the one that held the
      // bytes.
      const second = chunk({ command_id: 'cmd-c', seq: 2, bytes_b64: Buffer.from('world').toString('base64'), bytes_total: 5 })
      const first = chunk({ command_id: 'cmd-c', seq: 1, bytes_b64: Buffer.from('hello ').toString('base64'), bytes_total: 6 })

      expect(first.data._causes).toContain(opened.id)
      expect(second.data._causes).toContain(opened.id)
      const assembled = [second, first]
        .sort((a, b) => Number(a.data.seq) - Number(b.data.seq))
        .map((e) => Buffer.from(String(e.data.bytes_b64), 'base64').toString('utf8'))
        .join('')
      expect(assembled).toBe('hello world')
    })

    // T021, research.md T006. Once every command is relayed, `nmap -A` and
    // `ffuf` bodies arrive as a matter of course, and a truncated scan is the
    // evidence the operator most wanted. RedLog already solves this for HTTP
    // bodies — keep it whole, reference it — so command output takes the same
    // path rather than a bigger truncation limit that would have to be
    // re-argued the first time someone ran a full-port scan.
    it('keeps a large body whole, on disk, and leaves a reference', () => {
      const body = 'A'.repeat(60_000)
      const ev = shell({
        subtype: 'command_end', command: 'nmap -A 10.0.0.1', command_id: 'cmd-big',
        exit_code: 0, duration_sec: 40, cwd: '/root',
        stdout: body, stdout_bytes: body.length, stdout_truncated: false,
        completeness: 'complete', output_disposition: 'captured'
      }).event!

      const ref = ev.data.stdout_ref as { sha256: string; size: number; file: string } | undefined
      expect(ref, 'the body was not externalised').toBeTruthy()
      expect(ref!.size).toBe(body.length)
      expect(ref!.sha256).toMatch(/^[0-9a-f]{64}$/)
      // The bytes are not on the row — that is the point — and the row still
      // says the record is complete, because it is.
      expect(ev.data.stdout).toBeUndefined()
      expect(ev.data.completeness).toBe('complete')
      expect(ev.data.stdout_bytes).toBe(body.length)
    })

    it('leaves a small body where every reader already looks for it', () => {
      // Under the threshold nothing moves. A reference for forty bytes would
      // be a file per command and a second place to look for the common case.
      const ev = shell({
        subtype: 'command_end', command: 'whoami', command_id: 'cmd-small',
        exit_code: 0, duration_sec: 0, cwd: '/root', stdout: 'root\n'
      }).event!

      expect(ev.data.stdout).toBe('root\n')
      expect(ev.data.stdout_ref).toBeUndefined()
    })

    it('ends the command by its id even when the text no longer matches', () => {
      // The old key is `terminal|pid|command`, so the two ends of one command
      // correlate only while the text is byte-identical. It is not always:
      // zsh's `preexec` is handed the line as typed, and what a later row
      // reports can be the expanded or aliased form. The id does not care.
      const opened = start('cmd-d', 'nmap -sV 10.0.0.9')
      const ended = shell({
        subtype: 'command_end', command: '/usr/bin/nmap -sV 10.0.0.9', command_id: 'cmd-d',
        exit_code: 0, duration_sec: 3, cwd: '/root', pid: 4242
      }).event!

      expect(ended.data._causes).toContain(opened.id)
    })
  })

  // Spec 017 FR-014 / Domain Invariant #8. `timestamp` is when the thing
  // happened at its source, `created_at` is when RedLog wrote it down. Before
  // this they were the same `Date.now()` on every path, so a transcript
  // replayed hours later claimed to have happened at the moment of replay.
  describe('source occurrence time', () => {
    const marker = (data: Record<string, unknown>, occurredAt?: number) =>
      ingestMod.ingest({ ...base, agentType: 'marker', data, ...(occurredAt ? { occurredAt } : {}) })

    it("takes the producer's own time into `timestamp` and keeps `created_at` as receipt", () => {
      const occurred = Date.now() - 3 * 60 * 60 * 1000
      const before = Date.now()
      const ev = marker({ title: 'replayed', source_timestamp: occurred }).event!

      expect(ev.timestamp).toBe(occurred)
      expect(ev.createdAt).toBeGreaterThanOrEqual(before)
      expect(ev.createdAt).not.toBe(ev.timestamp)
    })

    it('an explicit occurredAt outranks what the producer left in `data`', () => {
      const explicit = Date.now() - 60_000
      const ev = marker({ title: 'both', source_timestamp: Date.now() - 7_200_000 }, explicit).event!
      expect(ev.timestamp).toBe(explicit)
    })

    it('equal times for anything captured live', () => {
      const ev = marker({ title: 'live' }).event!
      expect(ev.timestamp).toBe(ev.createdAt)
    })

    it('refuses a source time it cannot believe, and the refusal is inside the hash', () => {
      // Seconds-precision epoch read as milliseconds: lands in 1970 and would
      // drag the row to the far left of every timeline, permanently — the
      // column is immutable.
      const before = Date.now()
      const ev = marker({ title: 'bad clock', source_timestamp: 1_700_000_000 }).event!

      expect(ev.timestamp).toBeGreaterThanOrEqual(before)
      expect(ev.timestamp).toBe(ev.createdAt)
      expect(ev.data._source_time_rejected).toMatchObject({ value: 1_700_000_000 })
    })

    it('a backfilled row is not mistaken for a clock that ran backwards', async () => {
      // The anomaly detectors compare monotonic counters against the RECEIPT
      // clock. Pointed at `timestamp` instead, every row of a replayed
      // transcript reads as the wall clock jumping, and verification screams
      // about exactly the data this feature exists to represent.
      marker({ title: 'backfill a', source_timestamp: Date.now() - 86_400_000 })
      marker({ title: 'backfill b', source_timestamp: Date.now() - 43_200_000 })
      const live = marker({ title: 'live again' }).event!

      expect(live.data._clock_anomaly).toBeUndefined()
      const res = await chain.verifyChainFullAsync()
      expect(res.ok, res.brokenReason ?? '').toBe(true)
      expect(res.clockAnomalies).toHaveLength(0)
    })
  })
})
