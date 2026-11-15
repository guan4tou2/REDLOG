// Spec 071 FR-007 / T021: a new row's engagement is the project's own id. A
// project whose config.yaml is missing, names no `engagement.id`, or names the
// shared `default` (projects created before 2026-09-06, or opened once with no
// file so that `default` was written back) is opened as engagement = project
// id, the project directory's name (core/project-manager.ts createProject).
//
// What it used to do: every such project was engagement `default`, so two of
// them shared one id — and the handoff spool decides which project a file
// belongs to by exactly that id, so one project's file was drained into the
// other.
//
// The owner chose (2026-11-15) to treat an explicit `default` like a missing
// id. The cost, stated in the PR: surfaces that filter by engagement (Activity
// and the like) no longer show such a project's old `default` rows. Those rows
// are not touched: same bytes, same hashes, the chain still verifies and an
// export still delivers them.
//
// `startProject` (src/main/index.ts) is the Electron entry point and cannot be
// imported; "open" here is what it does with the file and the database:
// prepareOpenConfig, initDB, bindDBEngagement(config.engagement.id).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, prepareOpenConfig, readConfig, saveConfig } from '../src/core/config'
import { initDB, closeDB, bindDBEngagement, dbEngagement, getDB } from '../src/core/db/index'
import * as events from '../src/core/db/events'
import * as ops from '../src/core/db/operators'
import { _resetIngest } from '../src/core/ingest'
import { verifyChainFullAsync } from '../src/core/chain-anchor'
import { exportBundle } from '../src/core/bundle-export'
import { verifyBundleDir } from '../src/core/bundle-verify'
import { VERIFY_EXIT, type VerifyCategory } from '../src/core/evidence-rules'
import { replaySpoolDirectory, type SpoolReplayEvent } from '../src/core/spool-replay'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

const VERIFIER = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0) ?? null
const hasCryptography = python
  ? spawnSync(python, ['-I', '-c', 'import cryptography.hazmat.primitives.asymmetric.ed25519']).status === 0
  : false
const CATEGORY_BY_EXIT = Object.fromEntries(Object.entries(VERIFY_EXIT).map(([k, v]) => [v, k])) as Record<number, VerifyCategory>

let root: string
const keysEnv = process.env.REDLOG_KEYS_DIR
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-eng-project-'))
  process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
  _resetIngest()
})
afterEach(() => {
  closeDB()
  if (keysEnv === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = keysEnv
  fs.rmSync(root, { recursive: true, force: true })
})

/** A project directory named by its id, as createProject makes one. */
function project(id: string, configYaml?: string): string {
  const dir = path.join(root, 'projects', id)
  fs.mkdirSync(dir, { recursive: true })
  if (configYaml !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml)
  return dir
}

/** What startProject does with the file and the database. */
function open(dir: string): string {
  const config = prepareOpenConfig(dir)
  initDB(dir)
  bindDBEngagement(config.engagement.id)
  return config.engagement.id
}

function markerHandler(id: string, dir: string): Handler {
  const handlers = new Map<string, Handler>()
  const ctx = {
    getSelectedTarget: () => null, getActiveProject: () => ({ id, name: id, path: dir, createdAt: 1, lastOpened: 1 }),
    getMainWindow: () => ({})
  } as unknown as IpcContext
  registerMarkersIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ctx, {} as never)
  return handlers.get('marker:create')!
}

const engagementOf = (id: string): string =>
  (getDB().prepare('SELECT engagement_id FROM events WHERE id = ?').get(id) as { engagement_id: string }).engagement_id

// The one written back by an earlier open: today's saveConfig of the defaults.
const writtenBack = (): string => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-eng-written-back-'))
  try { saveConfig(scratch, structuredClone(DEFAULT_CONFIG)); return fs.readFileSync(path.join(scratch, 'config.yaml'), 'utf8') } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

const CASES: Array<[string, string | undefined | (() => string)]> = [
  ['no config.yaml', undefined],
  ['a config.yaml with only `operator:`', 'operator:\n  id: op-a\n  name: Ana\n'],
  ['a config.yaml that says `engagement.id: default`', 'engagement:\n  id: default\noperator:\n  id: op-a\n'],
  ['a config.yaml an earlier open wrote back with `default`', writtenBack],
  ['a config.yaml with an empty `engagement.id`', 'engagement:\n  id: ""\n']
]

describe('a project whose config names no engagement of its own is its project id', () => {
  for (const [name, text] of CASES) {
    it(`${name}: the database, every config reader, a written row and an IPC marker all say the project id`, () => {
      const dir = project('alpha-m1x2', typeof text === 'function' ? text() : text)
      const bound = open(dir)
      expect(bound).toBe('alpha-m1x2')
      expect(dbEngagement()).toBe('alpha-m1x2')
      // What the IPC handlers read for themselves, after the open.
      expect(loadConfig(dir).engagement.id).toBe('alpha-m1x2')
      expect(readConfig(dir)).toMatchObject({ config: { engagement: { id: 'alpha-m1x2' } } })

      const row = events.insertEvent('system', { subtype: 'session_start' }, { operatorId: 'op' })!
      expect(row.engagementId).toBe('alpha-m1x2')
      expect(engagementOf(row.id)).toBe('alpha-m1x2')

      // ipc/markers.ts reads engagement.id from loadConfig and names it; a
      // `default` there is refused as another engagement's row (event-write.ts).
      const marker = markerHandler('alpha-m1x2', dir)({}, { title: 'note' }) as { id: string; engagementId: string } | null
      expect(marker, 'the marker was refused as another engagement\'s').not.toBeNull()
      expect(marker!.engagementId).toBe('alpha-m1x2')
      expect(engagementOf(marker!.id)).toBe('alpha-m1x2')
    })
  }

  it('a config.yaml that names its own engagement keeps it', () => {
    const dir = project('beta-m1x2', 'engagement:\n  id: eng-own\n')
    expect(open(dir)).toBe('eng-own')
    expect(loadConfig(dir).engagement.id).toBe('eng-own')
  })

  it('startProject binds the database and starts its resources from the one config it prepared', () => {
    // The readers above agree with the binding because they read the same
    // file through the same rule; this pins that startProject does not take
    // the id from anywhere else.
    const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf-8')
    const body = src.slice(src.indexOf('function startProject('), src.indexOf('function startProjectResources('))
    expect(body).toMatch(/const config = prepareOpenConfig\(projectDir\)/)
    expect(body).toMatch(/projectRuntime\.begin\(project, \{ engagementId: config\.engagement\.id,/)
    expect(body).toMatch(/bindDBEngagement\(config\.engagement\.id\)/)
    expect(body).toMatch(/startProjectResources\(project, projectDir, config, opening\)/)
    expect(body.match(/[\w.]*engagement\.id\b/g)).toEqual(['config.engagement.id', 'config.engagement.id'])
  })
})

describe('the rows a `default` project already holds', () => {
  const OLD = 3
  function seedOld(dir: string): Array<Record<string, unknown>> {
    initDB(dir); bindDBEngagement('default')
    ops.createOperator({ id: 'op', name: 'op', token: ops.generateToken(), isPrimary: true })
    getDB().transaction(() => {
      for (let i = 0; i < OLD; i++) events.insertEvent('shell', { subtype: 'command_start', command: `old-${i}` }, { operatorId: 'op' })
    })()
    const rows = getDB().prepare('SELECT * FROM events ORDER BY rowid').all() as Array<Record<string, unknown>>
    closeDB()
    return rows
  }

  it('stay byte for byte, the chain verifies across the change, and an export delivers both and both verifiers accept it', { timeout: 60_000 }, async () => {
    const dir = project('gamma-m1x2', 'engagement:\n  id: default\noperator:\n  id: op\n')
    const before = seedOld(dir)
    expect(before.filter((r) => r.engagement_id === 'default').length).toBeGreaterThanOrEqual(OLD)

    expect(open(dir)).toBe('gamma-m1x2')
    const fresh = events.insertEvent('shell', { subtype: 'command_start', command: 'new' }, { operatorId: 'op' })!
    expect(fresh.engagementId).toBe('gamma-m1x2')

    const after = getDB().prepare('SELECT * FROM events ORDER BY rowid').all() as Array<Record<string, unknown>>
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.at(-1)).toMatchObject({ id: fresh.id, engagement_id: 'gamma-m1x2', prev_hash: before.at(-1)!.hash })

    const chain = await verifyChainFullAsync()
    expect(chain.ok, chain.brokenReason ?? '').toBe(true)
    expect(chain.walked).toBe(after.length)

    const bundle = exportBundle('gamma-m1x2', { outRoot: path.join(root, 'out'), scope: { targets: [], excludeTargets: [] } }).outDir
    const delivered = fs.readFileSync(path.join(bundle, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    for (const r of before) expect(delivered.find((d) => d.id === r.id)).toMatchObject({ engagement_id: 'default', hash: r.hash })
    expect(delivered.find((d) => d.id === fresh.id)).toMatchObject({ engagement_id: 'gamma-m1x2' })

    const ts = verifyBundleDir(bundle, { hashOnly: python !== null && !hasCryptography })
    expect(ts.category, ts.problems.join('\n')).toBe('verified')
    if (python) {
      const r = spawnSync(python, ['-I', VERIFIER, ...(hasCryptography ? [] : ['--hash-only']), bundle], { encoding: 'utf8' })
      expect(CATEGORY_BY_EXIT[r.status ?? -1], r.stdout + r.stderr).toBe(ts.category)
    }
  })
})

describe('the handoff spool tells config-less projects apart', () => {
  const spool = (): string => { const d = path.join(root, 'spool'); fs.mkdirSync(d, { recursive: true }); return d }
  function handoff(d: string, name: string, engagementId: string): string {
    const file = path.join(d, `${name}.json`)
    fs.writeFileSync(file, JSON.stringify({ agent_type: 'shell', data: { command: name }, _identity: { engagementId, operatorId: 'op-a' } }))
    return file
  }

  it('a file observed under one config-less project is not drained into another', () => {
    const a = project('alpha-m1x2')
    const b = project('bravo-m1x2')
    const d = spool()
    // The identity the hooks stamp is the open project's (writeSpoolIdentity).
    const file = handoff(d, 'from-a', loadConfig(a).engagement.id)
    const emitted: SpoolReplayEvent[] = []
    const asB = replaySpoolDirectory(d, { engagementId: loadConfig(b).engagement.id, operatorId: 'op-b' }, (e) => { emitted.push(e); return true })
    expect(emitted).toEqual([])
    expect(asB.outcomes['from-a.json']).toBe('deferred')
    expect(fs.existsSync(file)).toBe(true)

    const asA = replaySpoolDirectory(d, { engagementId: loadConfig(a).engagement.id, operatorId: 'op-a' }, (e) => { emitted.push(e); return true })
    expect(asA.outcomes['from-a.json']).toBe('ingested')
    expect(emitted.map((e) => e.engagementId)).toEqual(['alpha-m1x2'])
  })

  it('a file written under the shared `default` before the change belongs to no project it can be told from: set aside as no-project, not drained', () => {
    const d = spool()
    const file = handoff(d, 'shared', 'default')
    const emitted: SpoolReplayEvent[] = []
    const r = replaySpoolDirectory(d, { engagementId: 'alpha-m1x2', operatorId: 'op-a' }, (e) => { emitted.push(e); return true })
    expect(emitted).toEqual([])
    expect(r.outcomes['shared.json']).toBe('quarantined')
    expect(r.unattributed).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
    const q = path.join(d, 'quarantine', '_no-project')
    const kept = fs.readdirSync(q).filter((n) => n.endsWith('.json'))
    expect(kept).toEqual(['no-project--shared.json'])
    const why = fs.readdirSync(q).find((n) => n !== kept[0])
    expect(why && fs.readFileSync(path.join(q, why), 'utf8')).toMatch(/default/)
  })
})
