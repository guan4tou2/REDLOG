// Decision 2026-11-15 §3: an AI conversation's raw transcript is searched
// while "hide non-work traffic" is on, as terminal recordings are (§1 item 4).
// The flag is on by default, and it was counted as a condition a raw
// transcript cannot apply, so in the default state a word only in the raw
// file was never found and coverage listed every raw transcript as excluded.
// Target, time, in-scope, tier and the parsed conditions still cannot be
// applied to a file-precision source and still exclude it.
import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { requires } from './helpers/requires'
import { parsed } from './helpers/body-index-work'
import type { EventFilter } from '../src/core/db/event-queries'

const sqlite = requires('better-sqlite3')
let db: typeof import('../src/core/db/index')
let write: typeof import('../src/core/db/event-write')
let queries: typeof import('../src/core/db/event-queries')
let activity: typeof import('../src/core/db/activity-queries')
let idx: typeof import('../src/core/http-body-index')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  write = await import('../src/core/db/event-write')
  queries = await import('../src/core/db/event-queries')
  activity = await import('../src/core/db/activity-queries')
  idx = await import('../src/core/http-body-index')
}

let dir = '', snapshotId = ''
// The renderer's default: non-work traffic hidden, with domains to hide.
const DEFAULT: EventFilter = { hidePersonal: true, personalDomains: ['facebook.com'] }

sqlite.describe('AI raw transcripts and hidden non-work traffic', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-raw-personal-'))
    db.initDB(dir)
    fs.mkdirSync(path.join(dir, 'agent-transcripts'))
    const file = path.join(dir, 'agent-transcripts', 'session.jsonl'), text = '{"note":"RAWONLYWORD"}\n'
    fs.writeFileSync(file, text)
    snapshotId = write.insertEvent('agent', { subtype: 'transcript_snapshot', agent: 'claude-code', session_id: 'conversation', snapshot_path: file,
      cumulative_bytes: Buffer.byteLength(text), cumulative_sha256: createHash('sha256').update(text).digest('hex') }, { engagementId: 'eng', operatorId: 'op' })!.id
  })
  afterEach(() => { idx.closeHttpBodyIndex(); db.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const search = (filter: EventFilter) => queries.executeEventQuery({ parsed: parsed('RAWONLYWORD'), filter, limit: 10 })
  const raw = (page: ReturnType<typeof search>) => page.bodyCoverage!.sources!.find(s => s.kind === 'ai-raw')!

  it('finds a word only in the raw transcript under the default filter, and does not call it excluded', () => {
    const page = search(DEFAULT)
    expect(page.items.map(e => e.id)).toEqual([snapshotId])
    expect(raw(page)).toMatchObject({ status: 'covered', indexed: 1, unsupported: 0 })
    expect(raw(page).filters.unsupported).toEqual([])
    // Not claimed as applied to the file either: it was not.
    expect(raw(page).filters.applied).toEqual([])
    expect(page.bodyCoverage!.sources!.find(s => s.kind === 'events')!.filters.applied).toEqual(['hidePersonal', 'personalDomains'])
    expect(page.bodyCoverage!.unsupported).toBe(0)
    expect(queries.countEvents({ parsed: parsed('RAWONLYWORD'), filter: DEFAULT })).toBe(1)
    expect(queries.matchEventIds({ parsed: parsed('RAWONLYWORD'), filter: DEFAULT, ids: [snapshotId] })).toEqual([snapshotId])
  })

  it('answers the same with non-work traffic shown', () => {
    for (const filter of [{}, { hidePersonal: false, personalDomains: ['facebook.com'] }] as EventFilter[]) {
      const page = search(filter)
      expect(page.items.map(e => e.id)).toEqual([snapshotId])
      expect(raw(page)).toMatchObject({ status: 'covered', indexed: 1, unsupported: 0 })
    }
  })

  it('still leaves it out under a time or target filter, and says so', () => {
    for (const extra of [{ since: 1 }, { targetId: 'h.test' }, { inScopeOnly: true }] as EventFilter[]) {
      const page = search({ ...DEFAULT, ...extra })
      expect(page.items, JSON.stringify(extra)).toEqual([])
      expect(raw(page), JSON.stringify(extra)).toMatchObject({ status: 'unsupported', unsupported: 1, indexedBytes: 0 })
      expect(raw(page).filters.unsupported, JSON.stringify(extra)).toEqual(Object.keys(extra))
    }
  })

  it('the Activity page finds it under the default filter too', () => {
    const page = activity.queryActivityPage({ projectId: 'eng', parsed: parsed('RAWONLYWORD'), filter: DEFAULT, limit: 10 })
    expect(page.items.flatMap(a => a.matchedPreview.ids)).toEqual([snapshotId])
    expect(page.bodyCoverage!.sources!.find(s => s.kind === 'ai-raw')).toMatchObject({ status: 'covered', unsupported: 0 })
  })
})
