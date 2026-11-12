import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { isExternalEventAllowed } from '../src/core/external-event-policy'

// c2-tailers bundled pack (SPEC-AI-ERA-PLUGINS Gap 2). The parser ships as a
// dependency-free CommonJS module; required directly to pin its output shape.
const require_ = createRequire(import.meta.url)
const { parseC2Line, parseC2Log } = require_('../plugins/c2-tailers/parse.js')
const { initialOffset, resyncOffset, completeLines, drainLines, postOutcome } = require_('../plugins/c2-tailers/follow.js')

describe('generic C2 contract', () => {
  it('maps a check-in to scanner.c2_checkin with the host as target', () => {
    const ev = parseC2Line('{"kind":"checkin","framework":"mythic","session":"b-01","host":"10.0.0.5","os":"linux","user":"root","is_beacon":true}', 'generic')
    expect(ev).toMatchObject({ agent_type: 'scanner', target_id: '10.0.0.5' })
    expect(ev.data).toMatchObject({ subtype: 'c2_checkin', framework: 'mythic', session: 'b-01', os: 'linux', user: 'root', is_beacon: true })
  })

  it('maps a task to scanner.c2_task', () => {
    const ev = parseC2Line('{"kind":"task","session":"b-01","host":"10.0.0.5","command":"whoami","output_len":12}', 'generic')
    expect(ev.data).toMatchObject({ subtype: 'c2_task', command: 'whoami', output_len: 12 })
  })

  // #687: `pivot` is RedLog's own conclusion and POST /api/events refuses it
  // from outside tools, so a C2 pivot is reported as the framework's record.
  it('maps a pivot to scanner.c2_pivot with the via host as target', () => {
    const ev = parseC2Line('{"kind":"pivot","framework":"sliver","via":"10.0.0.5","route":"10.1.0.0/16"}', 'generic')
    expect(ev).toMatchObject({ agent_type: 'scanner', target_id: '10.0.0.5' })
    expect(ev.data).toMatchObject({ subtype: 'c2_pivot', framework: 'sliver', state: 'open', via: '10.0.0.5', route: '10.1.0.0/16' })
  })

  it('closed pivot → state closed', () => {
    const ev = parseC2Line('{"kind":"pivot","via":"h","closed":true}', 'generic')
    expect(ev.data).toMatchObject({ subtype: 'c2_pivot', state: 'closed' })
  })

  it('posts only types the external API accepts, and declares every subtype it emits', () => {
    const lines = [
      '{"kind":"checkin","host":"h1"}',
      '{"kind":"task","host":"h1","command":"id"}',
      '{"kind":"pivot","via":"h1"}',
      '{"kind":"pivot","via":"h1","closed":true}'
    ]
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../plugins/c2-tailers/plugin.json'), 'utf-8'))
    const generic = manifest.contributes.capture.find((c: { id: string }) => c.id === 'generic-c2-tail')
    for (const line of lines) {
      const ev = parseC2Line(line, 'generic')
      expect(isExternalEventAllowed(ev.agent_type, ev.data), line).toBe(true)
      expect(ev.agent_type).toBe(generic.agentType)
      expect(generic.emits).toContain(ev.data.subtype)
    }
  })

  it('skips unknown kinds and junk', () => {
    expect(parseC2Line('{"kind":"heartbeat"}', 'generic')).toBeNull()
    expect(parseC2Line('not json', 'generic')).toBeNull()
    expect(parseC2Line('', 'generic')).toBeNull()
  })
})

describe('sliver mapping (best-effort)', () => {
  it('maps a Sliver session object to c2_checkin', () => {
    const line = '{"ID":"a1b2","Name":"CRAZY_HORSE","Hostname":"dc01","Username":"NT/SYSTEM","OS":"windows","RemoteAddress":"10.0.0.9:4444","IsBeacon":true}'
    const ev = parseC2Line(line, 'sliver')
    expect(ev).toMatchObject({ agent_type: 'scanner', target_id: 'dc01' })
    expect(ev.data).toMatchObject({ subtype: 'c2_checkin', framework: 'sliver', session: 'CRAZY_HORSE', os: 'windows', user: 'NT/SYSTEM', is_beacon: true })
  })

  it('skips objects with no identifying fields', () => {
    expect(parseC2Line('{"level":"debug","msg":"tick"}', 'sliver')).toBeNull()
  })
})

describe('parseC2Log', () => {
  it('parses a JSONL blob, skipping blank/unparseable lines', () => {
    const blob = [
      '{"kind":"checkin","host":"h1"}',
      '',
      'garbage',
      '{"kind":"task","host":"h1","command":"id"}'
    ].join('\n')
    expect(parseC2Log(blob, 'generic')).toHaveLength(2)
  })
})

// #687: the follower used to start at byte 0 (flooding the open project with
// the whole existing log) and advanced its offset to EOF before posting, so a
// line read while RedLog was closed or a post failed was consumed and lost.
describe('c2-tail offsets', () => {
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
  const parse = (line: string): Record<string, unknown> | null => parseC2Line(line, 'generic')
  const log = ['{"kind":"checkin","host":"a"}', '{"kind":"checkin","host":"b"}', '{"kind":"checkin","host":"c"}'].join('\n') + '\n'

  it('starts at the end of an existing log unless --from-start is given', () => {
    expect(initialOffset(500, false)).toBe(500)
    expect(initialOffset(500, true)).toBe(0)
    // A log that does not exist yet is all new.
    expect(initialOffset(null, false)).toBe(0)
  })

  it('restarts from 0 on truncation or rotation, and otherwise keeps its place', () => {
    expect(resyncOffset(100, { size: 40, ino: 7 }, 7)).toBe(0)
    expect(resyncOffset(100, { size: 400, ino: 8 }, 7)).toBe(0)
    expect(resyncOffset(100, { size: 400, ino: 7 }, 7)).toBe(100)
  })

  it('leaves a line still being written for the next read', () => {
    const lines = completeLines(buf('{"a":1}\n{"b":'))
    expect(lines).toEqual([{ line: '{"a":1}', end: 8 }])
  })

  it('advances past every line once all are posted', async () => {
    const hosts: unknown[] = []
    const r = await drainLines(buf(log), 10, parse, async (ev: { data: { host: string } }) => { hosts.push(ev.data.host); return 'ok' })
    expect(hosts).toEqual(['a', 'b', 'c'])
    expect(r).toMatchObject({ offset: 10 + Buffer.byteLength(log), posted: 3, stalled: false })
  })

  it('stops at the first post to retry and resumes from that line', async () => {
    const seen: string[] = []
    let calls = 0
    const first = await drainLines(buf(log), 0, parse, async (ev: { data: { host: string } }) => {
      seen.push(ev.data.host)
      return ++calls === 2 ? 'retry' : 'ok'
    })
    // Only "a" is consumed; "b" failed and "c" was never tried.
    expect(seen).toEqual(['a', 'b'])
    expect(first).toMatchObject({ offset: Buffer.byteLength(log.split('\n')[0] + '\n'), posted: 1, stalled: true })
    const rest = buf(log).subarray(first.offset)
    const again: string[] = []
    const second = await drainLines(rest, first.offset, parse, async (ev: { data: { host: string } }) => { again.push(ev.data.host); return 'ok' })
    expect(again).toEqual(['b', 'c'])
    expect(second.offset).toBe(Buffer.byteLength(log))
  })

  it('consumes nothing while RedLog is closed', async () => {
    const r = await drainLines(buf(log), 0, parse, async () => 'retry')
    expect(r).toMatchObject({ offset: 0, posted: 0, stalled: true })
  })

  it('skips junk and refused lines instead of stalling on them', async () => {
    const text = 'not json\n{"kind":"checkin","host":"a"}\n{"kind":"checkin","host":"b"}\n'
    const r = await drainLines(buf(text), 0, parse, async (ev: { data: { host: string } }) => (ev.data.host === 'a' ? 'drop' : 'ok'))
    expect(r).toMatchObject({ offset: Buffer.byteLength(text), posted: 1, dropped: 1, stalled: false })
  })

  it('counts byte offsets, not characters, across multi-byte text', async () => {
    const text = '{"kind":"task","host":"h","command":"echo 測試"}\n'
    const r = await drainLines(buf(text), 0, parse, async () => 'ok')
    expect(r.offset).toBe(Buffer.byteLength(text))
    expect(r.offset).toBeGreaterThan(text.length)
  })

  it('retries what can succeed later and drops what will be refused again', () => {
    expect(postOutcome(200)).toBe('ok')
    expect(postOutcome(403)).toBe('drop')
    expect(postOutcome(400)).toBe('drop')
    expect(postOutcome(401)).toBe('retry')
    expect(postOutcome(429)).toBe('retry')
    expect(postOutcome(503)).toBe('retry')
  })
})

// ---------------------------------------------------------------------------

import { validateManifest, tierOf, collectFileRefs } from '../src/core/plugins/manifest'

// Salvaged from PR #8 alongside the parsers above. Sitting in the directory is
// not the same as loading: the manifest schema moved while the branch sat
// unmerged, and a bundled plugin that fails validation is worse than an absent
// one — the capture source appears in the roadmap and never fires.
describe('the bundled c2-tailers plugin actually loads', () => {
  const dir = path.join(__dirname, '../plugins/c2-tailers')
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'))

  it('validates against the current manifest schema', () => {
    const parsed = validateManifest(raw, dir)
    expect(parsed.errors ?? [], (parsed.errors ?? []).join('; ')).toEqual([])
    expect(parsed.manifest).toBeTruthy()
  })

  it('is a shell-side pack, so nothing runs inside RedLog', () => {
    // The whole reason this is safe to bundle. It follows a log and POSTs to
    // the local API; it does not execute inside the app.
    const { manifest } = validateManifest(raw, dir)
    expect(tierOf(manifest!)).toBe('declarative')
  })

  it('every file the manifest names exists', () => {
    const { manifest } = validateManifest(raw, dir)
    const missing = collectFileRefs(manifest!.contributes)
      .filter((f) => !fs.existsSync(path.join(dir, f)))
    expect(missing).toEqual([])
  })

  it('tracks its hooks as executable in git', () => {
    // The exec bit has to survive a fresh clone, and the filesystem stat mode
    // does not: Windows checkouts drop it entirely, so `fs.statSync().mode`
    // reads 0 there and asserting on it fails a green plugin. Git's own index
    // mode (100755) is the cross-platform source of truth — it is what a Unix
    // operator's clone will actually get.
    const { execFileSync } = require('child_process') as typeof import('child_process')
    const out = execFileSync('git', ['ls-files', '-s', 'plugins/c2-tailers/hooks'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf-8'
    })
    const lines = out.trim().split('\n').filter(Boolean)
    expect(lines.length, 'no hooks tracked').toBeGreaterThan(0)
    for (const line of lines) {
      const mode = line.split(/\s/)[0]
      expect(mode, `${line} is not tracked 100755`).toBe('100755')
    }
  })
})
