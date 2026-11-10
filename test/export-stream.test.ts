import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { EventFileWriter, type EventFileFormat, type EventFileMetadata } from '../src/core/export-events-file'
import { eventsToNdjson } from '../src/core/ndjson-export'
import { fingerprintValue } from '../src/core/export-plan'
import { scrubOperatorPii } from '../src/core/operator-pii'
import type { RedLogEvent } from '../src/core/db/events'
const events = Array.from({length: 200}, (_,i) => ({id: String(i),timestamp: i,data: {stdout: 'x'.repeat(1000),home: os.homedir()}})) as RedLogEvent[]
const metadata = {config: {name: 'project',array: []},exportedAt: '2026-11-09T00:00:00.000Z',exportPlan: {id:'p',fingerprint:'f'}}
function write(format: EventFileFormat, rows: RedLogEvent[], meta: EventFileMetadata | null, scrub: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-writer-'))
  const file = path.join(dir, 'out')
  const fd = fs.openSync(file, 'wx')
  try {
    const writer = new EventFileWriter(fd, format, meta, scrub)
    for (const row of rows) writer.row(row)
    writer.end()
  } finally { fs.closeSync(fd) }
  try { return fs.readFileSync(file, 'utf8') } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
it.each([false,true])('preserves exact JSON and NDJSON bytes (PII scrub %s)', scrub => {
  for (const rows of [[],events]) {
    const expected = JSON.stringify({config:metadata.config,events:rows,exportedAt:metadata.exportedAt,exportPlan:metadata.exportPlan},null,2)
    expect(write('json',rows,metadata,scrub)).toBe(scrub ? scrubOperatorPii(expected) : expected)
    expect(write('ndjson',rows,null,scrub)).toBe(eventsToNdjson(rows,{alreadyRedacted:true,scrubOperatorPii:scrub}))
  }
})
it('streams the Timeline envelope without duplicate amendment payloads', () => {
  const meta = { selection: { kind: 'all' }, exportPlan: metadata.exportPlan }
  for (const rows of [[], events]) {
    expect(write('timeline', rows, meta, false)).toBe(JSON.stringify({ ...meta, events: rows, amendments: [] }, null, 2))
  }
})
it('hashes event arrays exactly as before without a giant intermediate JSON string', () => {
  expect(fingerprintValue(events)).toBe(createHash('sha256').update(JSON.stringify(events)).digest('hex'))
})
