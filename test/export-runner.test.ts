import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { runExportTask } from '../src/main/services/export-runner'
import type { ExportTask } from '../src/core/export-task'
import type { ProjectMeta } from '../src/core/project-manager'
import { takeExportSnapshot } from '../src/core/export-plan'

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
