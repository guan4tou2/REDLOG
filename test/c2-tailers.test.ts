import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

// c2-tailers bundled pack (SPEC-AI-ERA-PLUGINS Gap 2). The parser ships as a
// dependency-free CommonJS module; required directly to pin its output shape.
const require_ = createRequire(import.meta.url)
const { parseC2Line, parseC2Log } = require_('../plugins/c2-tailers/parse.js')

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

  it('maps a pivot to a pivot event aligned with the built-in shape', () => {
    const ev = parseC2Line('{"kind":"pivot","framework":"sliver","via":"10.0.0.5","route":"10.1.0.0/16"}', 'generic')
    expect(ev).toMatchObject({ agent_type: 'pivot', target_id: '10.0.0.5' })
    expect(ev.data).toMatchObject({ subtype: 'open', tool: 'sliver', via: '10.0.0.5', route: '10.1.0.0/16' })
  })

  it('closed pivot → subtype closed', () => {
    const ev = parseC2Line('{"kind":"pivot","via":"h","closed":true}', 'generic')
    expect(ev.data.subtype).toBe('closed')
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

// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
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

  it('ships its hooks executable', () => {
    for (const h of fs.readdirSync(path.join(dir, 'hooks'))) {
      const mode = fs.statSync(path.join(dir, 'hooks', h)).mode
      expect(mode & 0o111, `${h} is not executable`).toBeGreaterThan(0)
    }
  })
})
