import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { runExportTask } from '../src/main/services/export-runner'
import type { ExportTask } from '../src/core/export-task'
import type { ProjectMeta } from '../src/core/project-manager'
import { takeExportSnapshot, type ExportPlan } from '../src/core/export-plan'
import { buildExportPlan } from '../src/core/export-planning'

let dir: string, project: ProjectMeta
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-real-worker-'))
  initDB(dir)
  project = { id: 'p', name: 'worker', path: dir, createdAt: 1, lastOpened: 1 }
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES ('request',1,'p','s','op','scanner','http_request_start','host',?,1)`).run(JSON.stringify({ subtype: 'http_request_start', flow_id: 'flow', url: 'http://example.test/', method: 'GET' }))
  fs.rmSync(path.join(dir, 'screenshots'), { recursive: true, force: true })
  getDB().pragma('wal_checkpoint(TRUNCATE)')
})
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function har(): ExportTask {
  return { kind: 'har', project, outDir: path.join(dir, 'exports'), options: { snapshot: takeExportSnapshot(), includeEventIds: new Set(['request']) } }
}
it('runs the production worker read-only, publishes complete HAR and removes its private staging directory', async () => {
  const before = digest(path.join(dir, 'timeline.db'))
  const result = await runExportTask(har())
  if (!('artifactPath' in result)) throw new Error('artifact missing')
  expect(JSON.parse(fs.readFileSync(result.artifactPath, 'utf8')).log.entries[0].request.url).toBe('http://example.test/')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([path.basename(result.artifactPath)])
  expect(digest(path.join(dir, 'timeline.db'))).toBe(before)
  expect(fs.existsSync(path.join(dir, 'screenshots'))).toBe(false)
})
it('cancels a running production worker after project switch without a late delivery', async () => {
  let allowed = true, ticks = 0
  const running = runExportTask(har(), () => allowed)
  const pulse = setInterval(() => { ticks++; allowed = false }, 1)
  try { await expect(running).rejects.toThrow('project-changed') }
  finally { clearInterval(pulse) }
  expect(ticks).toBeGreaterThan(0)
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([])
})
it('refuses completed output when policy changes before publication', async () => {
  await expect(runExportTask(har(), completed => {
    if (completed) throw new Error('policy-changed')
    return true
  })).rejects.toThrow('policy-changed')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([])
})
it('does not remove a replacement directory it no longer owns', async () => {
  let replaced = false, retained = ''
  await expect(runExportTask(har(), completed => {
    if (completed && !replaced) {
      retained = fs.readdirSync(path.join(dir, 'exports')).find(name => name.startsWith('.redlog-export-'))!
      const stage = path.join(dir, 'exports', retained)
      fs.renameSync(stage, stage + '-original')
      fs.mkdirSync(stage)
      fs.writeFileSync(path.join(stage, 'unrelated'), 'keep')
      replaced = true
    }
    return true
  })).rejects.toThrow('staging directory changed')
  expect(fs.readFileSync(path.join(dir, 'exports', retained, 'unrelated'), 'utf8')).toBe('keep')
})

// JSON / NDJSON / Timeline delivery: selection, redaction and the digest check run in the worker.
function events(overrides: Record<string, unknown> = {}): ExportTask {
  const plan = buildExportPlan(project, { format: 'json' })
  return { kind: 'events', project, plan: { ...plan, ...overrides } as ExportPlan, format: 'ndjson', metadata: null, outDir: path.join(dir, 'exports') }
}
it('delivers an event file from the worker under the timestamped name and leaves no staging behind', async () => {
  const result = await runExportTask(events())
  if (!('artifactPath' in result)) throw new Error('artifact missing')
  expect(path.basename(result.artifactPath)).toMatch(/^redlog-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(-\d+)?\.ndjson$/)
  expect(JSON.parse(fs.readFileSync(result.artifactPath, 'utf8').trim()).id).toBe('request')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([path.basename(result.artifactPath)])
  const again = await runExportTask(events())
  if (!('artifactPath' in again)) throw new Error('artifact missing')
  expect(again.artifactPath).not.toBe(result.artifactPath)
  expect(fs.readFileSync(result.artifactPath, 'utf8')).toBe(fs.readFileSync(again.artifactPath, 'utf8'))
})
it('refuses an event file whose rows no longer match the approved digest, and publishes nothing', async () => {
  await expect(runExportTask(events({ selectedEvidenceDigest: 'not-the-approved-digest' }))).rejects.toThrow('source-unavailable')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([])
})
it('refuses an event file when the approved row count no longer matches', async () => {
  await expect(runExportTask(events({ selectedEventIds: ['request', 'gone'] }))).rejects.toThrow('source-unavailable')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([])
})
// The planned bundle path (Export menu → data:executeExportPlan). The worker's
// database is read-only and its snapshot is fixed, so the seal — the one
// chained row an export writes — is inserted here, on main, at the worker's
// request, and comes back as the bundle's last line.
it('seals a planned bundle built in the production worker, through main, and the recipient verifier accepts it', async () => {
  const before = (getDB().prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n
  const plan = buildExportPlan(project, { format: 'bundle' })
  // Recorded after the snapshot: outside the bundle, though before the seal.
  const { insertEvent } = await import('../src/core/db/events')
  const late = insertEvent('shell', { subtype: 'command_start', command: 'after the snapshot' }, { operatorId: 'op' })!
  const result = await runExportTask({ kind: 'bundle', project, approvedPlan: plan, engagementId: 'p', options: {
    snapshot: plan.snapshot, includeEventIds: new Set(plan.selectedEventIds), attachments: plan.attachments,
    exportPlan: { id: plan.id, fingerprint: plan.fingerprint, counts: plan.counts, request: plan.request },
    outRoot: path.join(dir, 'exports')
  }, attachmentDigest: plan.attachmentDigest })
  if (!('artifactPath' in result)) throw new Error('artifact missing')
  const lines = fs.readFileSync(path.join(result.artifactPath, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const seal = lines.at(-1)
  expect(JSON.parse(seal.data).subtype).toBe('export_sealed')
  expect(lines.map((r) => r.id)).not.toContain(late.id)
  // Main wrote exactly the seal (and the late row); the worker wrote nothing.
  expect((getDB().prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(before + 2)
  expect((getDB().prepare('SELECT id FROM events ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id).toBe(seal.id)
  const { verifyBundleDir } = await import('../src/core/bundle-verify')
  expect(verifyBundleDir(result.artifactPath).seal).toBe('sealed')
  const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0)
  if (python) {
    const r = spawnSync(python, ['-I', path.resolve('tools/redlog-verify.py'), '--hash-only', result.artifactPath], { encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Seal\s+: SEALED .*after rows recorded past the export boundary/)
  }
})
it('cancels a running event file after project switch and refuses it on a completion policy change', async () => {
  let allowed = true
  const running = runExportTask(events(), () => allowed)
  const pulse = setInterval(() => { allowed = false }, 1)
  try { await expect(running).rejects.toThrow('project-changed') } finally { clearInterval(pulse) }
  await expect(runExportTask(events(), completed => { if (completed) throw new Error('policy-changed'); return true })).rejects.toThrow('policy-changed')
  expect(fs.readdirSync(path.join(dir, 'exports'))).toEqual([])
})
