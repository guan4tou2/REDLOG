import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { writeApprovedEventExport } from '../src/core/export-stream'
import { eventsToNdjson } from '../src/core/ndjson-export'
import { fingerprintValue } from '../src/core/export-plan'
import { scrubOperatorPii } from '../src/core/operator-pii'
import type { RedLogEvent } from '../src/core/db/events'
const events = Array.from({length: 200}, (_,i) => ({id: String(i),timestamp: i,data: {stdout: 'x'.repeat(1000),home: os.homedir()}})) as RedLogEvent[]
const metadata = {config: {name: 'project',array: []},exportedAt: '2026-11-09T00:00:00.000Z',exportPlan: {id:'p',fingerprint:'f'}}
it.each([false,true])('preserves exact JSON and NDJSON bytes (PII scrub %s)', async scrub => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-worker-'))
  try {
    for (const rows of [[],events]) {
      const file = await writeApprovedEventExport(dir,'json',rows,metadata,scrub,()=>true)
      const expected = JSON.stringify({config:metadata.config,events:rows,exportedAt:metadata.exportedAt,exportPlan:metadata.exportPlan},null,2)
      expect(fs.readFileSync(file,'utf8')).toBe(scrub ? scrubOperatorPii(expected) : expected)
      const ndjson = await writeApprovedEventExport(dir,'ndjson',rows,null,scrub,()=>true)
      expect(fs.readFileSync(ndjson,'utf8')).toBe(eventsToNdjson(rows,{alreadyRedacted:true,scrubOperatorPii:scrub}))
    }
    expect(fs.readdirSync(dir)).toHaveLength(4)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
it('streams the Timeline envelope without duplicate amendment payloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-timeline-worker-'))
  try {
    const meta = { selection: { kind: 'all' }, exportPlan: metadata.exportPlan }
    for (const rows of [[], events]) {
      const file = await writeApprovedEventExport(dir, 'timeline', rows, meta, false, () => true)
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ ...meta, events: rows, amendments: [] }, null, 2))
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
it('hashes event arrays exactly as before without a giant intermediate JSON string', () => {
  expect(fingerprintValue(events)).toBe(createHash('sha256').update(JSON.stringify(events)).digest('hex'))
})
it('removes an incomplete file when the project changes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'redlog-export-abort-'))
  try {
    let checks=0
    await expect(writeApprovedEventExport(dir,'ndjson',events,null,false,()=>++checks<3)).rejects.toThrow('project-changed')
    expect(fs.readdirSync(dir)).toEqual([])
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
it('cleans delivery when a completion policy recheck rejects the artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-policy-'))
  try {
    await expect(writeApprovedEventExport(dir,'ndjson',events,null,false,completed => {
      if (completed) throw new Error('policy-changed')
      return true
    })).rejects.toThrow('policy-changed')
    expect(fs.readdirSync(dir)).toEqual([])
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
