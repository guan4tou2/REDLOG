import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { scrubOperatorPii } from '../src/core/operator-pii'
import { addExportEvent } from './helpers/export-fixtures'
import type { IpcContext } from '../src/main/ipc/types'

// Golden hashes of the bytes the pre-worker path (selection, redaction and
// digest on the main thread, rows posted to a writer worker in batches of 16)
// produced for this exact fixture. The plan id, plan fingerprint and exportedAt
// are the only run-specific values and are normalised before hashing. A change
// to where selection runs must leave every one of these unchanged.
const GOLDEN: Record<string, string> = {
  'json-full': '369e2c3931e9becdd0db5260b1502dd3752ee8cd8cd82c1f019948b70bc170bd',
  'ndjson-full': '67587c665d86214cbec97b9d9e52b9b2aa13c14d280d295a0979651632269c41',
  'json-sparse': '59223ec2f000a213a4f48d0e09db43913b28098e076a0f86e87cd35f9594ed04',
  'ndjson-sparse': '56af18c6c8b6eabcd4bd2944b465cb79ef33bad9997801cb8d0c603ba6dd5dcb',
  'timeline-sparse': '23715a454f419a7b25dd09d734a8937bae9c0d466c091ff17bb48c8182acb073',
  'json-empty': 'e48c9532d59b279e268a305bde24bde9a11160bf9982185d824e26a766251924',
  'ndjson-empty': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'timeline-empty': 'd3ce842f5cf41a15bd08cdad20095bb96f7dd24358114f0ed0df7d28abe31562',
  'json-masked': '20ebfcf90c8946e284f773438bdeec0a6281da71aa4ff6781cf1cd70c9dd8f10',
  'ndjson-masked': '408395f2c85a914e3d107530c1b60c38a4b89743d71675e246d715e53f323932'
}

let dir: string
let handlers: Map<string, (_event: unknown, input?: any) => any>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-equivalence-'))
  initDB(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), ['engagement:', '  id: eng-1', 'scope:', '  targets:', '    - in.test', '  excludeTargets: []', '  personalDomains: []'].join('\n'))
  const project = { id: 'eng-1', name: 'equivalence', path: dir, createdAt: 1, lastOpened: 1 }
  handlers = new Map()
  registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as never,
    { getActiveProject: () => project, getMainWindow: () => null, getCurrentEngagementId: () => project.id } as IpcContext)
  getDB().transaction(() => {
    for (let n = 0; n < 150; n++) {
      addExportEvent('events', `shell-${String(n).padStart(3, '0')}`, 1000 + n, {
        targetId: n % 3 === 0 ? 'out.test' : 'in.test',
        data: { command: `run-${n} ${os.homedir()}/notes`, stdout: `line ${n}\n`.repeat(1 + n % 7), café: 'ünï' }
      })
    }
    for (let n = 0; n < 60; n++) {
      addExportEvent('events_logged', `req-${n}`, 1000 + n * 2 + 1, { agentType: 'scanner', subtype: 'http_request_start', targetId: 'in.test', data: { flow_id: `f-${n}`, method: 'GET', url: `http://in.test/${n}` } })
      addExportEvent('events_logged', `res-${n}`, 1000 + n * 2 + 2, { agentType: 'scanner', subtype: 'http_response', targetId: 'in.test', data: { flow_id: `f-${n}`, status: 200, response_body: { data: `body-${n}`, encoding: 'text' } } })
    }
  })()
})
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

async function exportBytes(request: Record<string, unknown>): Promise<{ text: string; included: number }> {
  const resolved = await handlers.get('data:resolveExportPlan')!({}, request)
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
  const executed = await handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id })
  expect(executed.ok, JSON.stringify(executed)).toBe(true)
  const text = fs.readFileSync(executed.artifactPath, 'utf8')
    .split(resolved.plan.id).join('PLAN').split(resolved.plan.fingerprint).join('FINGERPRINT')
    .replace(/"exportedAt": "[^"]*"/, '"exportedAt": "T"')
  return { text, included: resolved.plan.counts.included }
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const sparse = { kind: 'time-range', since: 1130, before: 1140 }
const empty = { kind: 'time-range', since: 5, before: 6 }
const cases: Array<[string, Record<string, unknown>, number]> = [
  ['json-full', { format: 'json', maskOutOfScope: false }, 270],
  ['ndjson-full', { format: 'ndjson', maskOutOfScope: false }, 270],
  ['json-sparse', { format: 'json', maskOutOfScope: false, subset: sparse }, 11],
  ['ndjson-sparse', { format: 'ndjson', maskOutOfScope: false, subset: sparse }, 11],
  ['timeline-sparse', { format: 'timeline', maskOutOfScope: false, subset: sparse }, 11],
  ['json-empty', { format: 'json', maskOutOfScope: false, subset: empty }, 0],
  ['ndjson-empty', { format: 'ndjson', maskOutOfScope: false, subset: empty }, 0],
  ['timeline-empty', { format: 'timeline', maskOutOfScope: false, subset: empty }, 0],
  ['json-masked', { format: 'json', maskOutOfScope: true }, 270],
  ['ndjson-masked', { format: 'ndjson', maskOutOfScope: true }, 270]
]
it.each(cases)('%s writes the same bytes as the main-thread path did', async (name, request, included) => {
  const { text, included: count } = await exportBytes(request)
  expect(count).toBe(included)
  if (process.env.REDLOG_PRINT_GOLDEN) console.log(`GOLDEN ${name} ${sha(text)} ${text.length}`)
  else expect(sha(text)).toBe(GOLDEN[name])
})
it('masking changes the output, so the masked case is not the unmasked one by accident', async () => {
  const plain = await exportBytes({ format: 'ndjson', maskOutOfScope: false })
  const masked = await exportBytes({ format: 'ndjson', maskOutOfScope: true })
  expect(masked.text).not.toBe(plain.text)
})
it.each(['json', 'ndjson', 'timeline'])('%s with scrubPii equals the unscrubbed bytes with operator identifiers replaced', async format => {
  const subset = { kind: 'time-range', since: 1000, before: 1300 }
  const plain = await exportBytes({ format, maskOutOfScope: false, scrubPii: false, subset })
  const scrubbed = await exportBytes({ format, maskOutOfScope: false, scrubPii: true, subset })
  expect(plain.text).toContain(os.homedir().replace(/\\/g, '\\\\'))
  expect(scrubbed.text).toBe(scrubOperatorPii(plain.text))
  expect(scrubbed.text).toContain('<home>')
})
