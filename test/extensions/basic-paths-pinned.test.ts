// Spec 076 T002 (US1, FR-023): the basic paths, pinned. Every row written for a
// shell hook event, an AI tool transcript (Claude Code and Codex), a
// mitmproxy flow, a marker (IPC, HUD, API), the screenshot shortcut and an
// added artifact, and the bytes of the JSON, NDJSON and bundle exports of
// them, as today's code produces them. test/extensions/basic-paths.golden.json
// is the record.
//
// Spec 076 pulls optional sources out of the base layer and, later, moves some
// of them out of main. None of that may change what these paths write: FR-023
// holds every extraction PR to the same output before and after, and
// disable-all.test.ts (T003) holds it with every bundled plugin off. What a
// phase is allowed to change is `_ingest` (door, auth, credential, producer,
// received-at), row ids and every clock; they are left out of the record.
// What is left is the row: columns, target, data.
//
// How the run is built, and what each source goes through, is in
// basic-paths-fixture.ts. Three things this file says plainly:
//   - the shell hook step calls ingest() with the envelope POST /api/events
//     builds; the real route is exercised in the `listen` test below, which
//     compares its rows with the same record. A machine that cannot bind a port
//     skips that one test and says so.
//   - addHudMarker lives in main/index.ts and cannot be imported. The fixture
//     builds its body from its exported parts; the last test here pins the body
//     so the copy cannot drift from it.
//   - The raw export digests (`sha256`) are those of exports taken before the
//     steps that write a temp-directory path into a row; the `normalized`
//     digests also cover those rows. They differ when a phase changes `_ingest`
//     (raw only) — re-record; or when it changes anything else (both) — a bug.
//
// To re-record after an intended change to what these paths write:
//   REDLOG_WRITE_BASIC_PATHS=1 npx vitest run test/extensions/basic-paths-pinned.test.ts
// and say in the commit which row or digest moved and why.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { requires } from '../helpers/requires'
import { firstDiff, rowDiff, runBasicPaths, type BasicPathsRun } from './basic-paths-fixture'

const GOLDEN = path.join(__dirname, 'basic-paths.golden.json')
const WRITE = process.env.REDLOG_WRITE_BASIC_PATHS === '1'
const ROOT = path.join(__dirname, '..', '..')

const sqlite = requires('better-sqlite3')
const listen = requires('listen')

/** Round-tripped through JSON, as it is on disk. */
const plain = (run: BasicPathsRun): BasicPathsRun => JSON.parse(JSON.stringify(run))
const recorded = (): BasicPathsRun => JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))

/** The steps the run is made of, in order; one per source in the task. */
const STEPS = ['shell-hook', 'ai-claude-code', 'ai-codex', 'mitmproxy-flow', 'marker-ipc', 'marker-hud', 'marker-api', 'screenshot-hotkey', 'artifact-added']

sqlite.describe('the basic paths, as they are written today (Spec 076 T002)', () => {
  it('writes rows for every source, and no source is silent', async () => {
    const run = plain(await runBasicPaths())
    for (const step of STEPS) expect(run.rowsPerStep[step], `${step} wrote nothing`).toBeGreaterThan(0)
    // The exact counts are in the record; these are the ones a reader checks by eye.
    expect(run.rowsPerStep).toMatchObject({ 'shell-hook': 4, 'ai-claude-code': 4, 'ai-codex': 4, 'marker-ipc': 1, 'marker-hud': 2, 'marker-api': 1, 'screenshot-hotkey': 2, 'artifact-added': 1 })
    expect(run.rows.filter((r) => r.step === 'mitmproxy-flow').map((r) => r.data.subtype).sort()).toEqual(['http_request_start', 'http_response', 'session_cookie'])
  })

  it('is deterministic: a second run, in other temp directories, gives the same record', async () => {
    const first = plain(await runBasicPaths())
    const second = plain(await runBasicPaths())
    expect(second).toEqual(first)
  })

  it('rows and exports are the recorded ones', async () => {
    const run = plain(await runBasicPaths())
    if (WRITE) {
      fs.writeFileSync(GOLDEN, JSON.stringify(run, null, 1) + '\n')
      return
    }
    const golden = recorded()
    expect(run.rowsPerStep).toEqual(golden.rowsPerStep)
    // Row by row, so the failure names the row.
    run.rows.forEach((row, i) => expect(row, `row ${i} (${row.step}: ${String(row.data.subtype ?? row.columns.agent_type)}) first difference at ${rowDiff(run, golden, i)}`).toEqual(golden.rows[i]))
    expect(run.rows).toHaveLength(golden.rows.length)
    expect(run.exports.early.bundleFiles).toEqual(golden.exports.early.bundleFiles)
    expect(run.exports, `exports: first difference at ${firstDiff(run.exports, golden.exports)}`).toEqual(golden.exports)
  })

  it('the JSON, NDJSON and bundle exports carry the same rows (their normalized digests agree)', async () => {
    const { exports: e } = plain(await runBasicPaths())
    expect(e.early.json.normalizedSha256).toBe(e.early.ndjson.normalizedSha256)
    expect(e.final.json.normalizedSha256).toBe(e.final.ndjson.normalizedSha256)
    expect(e.early.json.rows).toBe(e.early.ndjson.rows)
  })

  // The route's own work, for the one source that goes through it.
  listen.it('POST /api/events stores the shell hook rows the record holds', async () => {
    const run = plain(await runBasicPaths({ shellDoor: 'http' }))
    const golden = WRITE ? run : recorded()
    const shell = (r: BasicPathsRun): unknown[] => r.rows.filter((x) => x.step === 'shell-hook')
    expect(shell(run)).toHaveLength(4)
    expect(shell(run)).toEqual(shell(golden))
  })
})

describe('the two copies in the fixture still match main (source pins)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  it('POST /api/events calls ingest() with the legacy-api entrance and the identity-mapper api envelope the fixture uses', () => {
    expect(read('src/core/api-server.ts')).toMatch(
      /result = ingest\(\{\s*agentType, data, operatorId: operator\.id, engagementId, targetId, entrance: LEGACY_API,\s*envelope: \{ source: 'api', mapper: \{ id: 'identity', version: '1' \} \}\s*\}\)/)
  })

  it('addHudMarker writes insertEvent(\'marker\', redactFields({ title, notes, severity, category, source_timestamp, source }, MARKER_TEXT_FIELDS), open)', () => {
    const body = read('src/main/index.ts')
    const start = body.indexOf('function addHudMarker(')
    expect(start).toBeGreaterThan(-1)
    const fn = body.slice(start, body.indexOf('\nconst WINDOW_STATE_PATH', start))
    expect(fn).toMatch(/const f = hudMarkerFields\(input, Date\.now\(\)\)/)
    expect(fn).toMatch(/insertEvent\('marker', redactFields\(\{\s*title: f\.title,\s*notes: f\.notes,\s*severity: 'info',\s*category: 'custom',\s*source_timestamp: f\.source_timestamp,\s*source: f\.source\s*\}, MARKER_TEXT_FIELDS\), open\)/)
  })

  it('the screenshot shortcut calls captureNow(\'manual\', undefined, { hideOwnWindows: true })', () => {
    expect(read('src/main/index.ts')).toMatch(/screenshotAgent\.captureNow\('manual', undefined, \{ hideOwnWindows: true \}\)/)
  })
})
