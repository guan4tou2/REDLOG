import fs from 'node:fs'
import { getReadonlyDB } from './db/index'
import { rowToEvent } from './db/event-types'
import { iterateSnapshotEvents } from './export-selection'
import { createHarDocument, type exportHar } from './har-export'
import { redactEventForExport } from './redact-export'
import type { RedLogEvent } from './db/events'

/** Planned HAR delivery retains flow metadata plus one flow, not all bodies and
 * the complete serialized HAR. Entry/partial-flow order and whitespace match
 * exportHar; selected IDs and snapshot bounds are never reconstructed from UI. */
export function writeApprovedHar(file: string, opts: NonNullable<Parameters<typeof exportHar>[0]>): void {
  if (!opts.snapshot || !opts.includeEventIds) throw new Error('HAR requires an approved snapshot')
  type Meta = { req?: number; res?: number; first: number }
  const requests = new Map<string, Meta>(), responses = new Map<string, Meta>()
  const chunks = new Map<string, Meta>(), messages = new Map<string, Meta>()
  const metadata = new Map<string, Meta>()
  const redaction = { scope: opts.scope, doNotExportIds: opts.doNotExportIds }
  for (const raw of iterateSnapshotEvents(opts.snapshot, { agentType: 'scanner', tier: 'logged', since: opts.since, before: opts.before, targetId: opts.targetId })) {
    if (!opts.includeEventIds.has(raw.id)) continue
    const event = redactEventForExport(raw, redaction)
    if (!event || typeof event.data.flow_id !== 'string' || !event.data.flow_id) continue
    const id = event.data.flow_id
    const meta = metadata.get(id) ?? { first: Infinity }
    if (event.data.subtype === 'http_response_chunk' || event.data.subtype === 'ws_message') meta.first = Math.min(meta.first, event.timestamp)
    metadata.set(id, meta)
    if (event.data.subtype === 'http_request_start') { meta.req = event.timestamp; requests.set(id, meta) }
    else if (event.data.subtype === 'http_response' && !responses.has(id)) { meta.res = event.timestamp; responses.set(id, meta) }
    else if (event.data.subtype === 'http_response_chunk') chunks.set(id, meta)
    else if (event.data.subtype === 'ws_message') messages.set(id, meta)
  }
  const entries = [...new Set([...requests.keys(), ...responses.keys()])]
    .sort((a,b) => (metadata.get(a)!.req ?? metadata.get(a)!.res!) - (metadata.get(b)!.req ?? metadata.get(b)!.res!))
  const partials = [...new Set([...chunks.keys(), ...messages.keys()])]
    .filter(id => !requests.has(id) && !responses.has(id)).sort((a,b) => metadata.get(a)!.first - metadata.get(b)!.first)
  // One lookup per flow, so each must be an index probe. `flow_id` is indexed
  // only by the two partial indexes in db/index.ts, and SQLite uses a partial
  // index only when the query repeats its WHERE terms — without the subtype
  // lists this scanned every scanner row once per flow, and a whole-project
  // HAR went quadratic (#695). The two lists together cover every subtype
  // createHarDocument reads.
  const flowRows = getReadonlyDB().prepare(`SELECT *, rowid AS _row, 'logged' AS tier FROM events_logged
      WHERE agent_type='scanner' AND subtype IN ('http_request_start', 'http_response')
        AND json_extract(data,'$.flow_id')=? AND rowid<=?
    UNION ALL
    SELECT *, rowid AS _row, 'logged' AS tier FROM events_logged
      WHERE agent_type='scanner' AND subtype IN ('http_response_chunk', 'ws_message', 'websocket_end', 'http_error', 'tcp_message', 'tcp_end')
        AND json_extract(data,'$.flow_id')=? AND rowid<=?
    ORDER BY timestamp DESC,_row DESC`)
  const readFlow = (id: string) => {
    const max = opts.snapshot!.loggedMaxRowId
    const rows = flowRows.iterate(id, max, id, max) as IterableIterator<Record<string, unknown>>
    const events: RedLogEvent[] = []
    for (const row of rows) {
      if (!opts.includeEventIds!.has(String(row.id))) continue
      const event = redactEventForExport(rowToEvent(row), redaction)
      if (event) events.push(event)
    }
    return createHarDocument(events)
  }
  const fd = fs.openSync(file, 'wx', 0o600)
  const write = (text: string) => { const buffer = Buffer.from(text); let offset = 0; while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length-offset) }
  const item = (value: unknown, indent: number) => JSON.stringify(value, null, 2).split('\n').map(line => ' '.repeat(indent)+line).join('\n')
  try {
    write('{\n  "log": {\n    "version": "1.2",\n    "creator": {\n      "name": "RedLog",\n      "version": "1.0.0"\n    },\n    "entries": [')
    for (const [index,id] of entries.entries()) {
      const value = readFlow(id).log.entries[0]
      if (!value) throw new Error('source-unavailable')
      write((index ? ',\n' : '\n') + item(value, 6))
    }
    write(entries.length ? '\n    ]' : ']')
    if (partials.length) {
      write(',\n    "_redlog": {\n      "partialFlows": [')
      for (const [index,id] of partials.entries()) {
        const value = readFlow(id).log._redlog?.partialFlows[0]
        if (!value) throw new Error('source-unavailable')
        write((index ? ',\n' : '\n') + item(value, 8))
      }
      write('\n      ]\n    }')
    }
    write('\n  }\n}')
    fs.fsyncSync(fd)
  } catch (error) {
    fs.closeSync(fd)
    fs.unlinkSync(file)
    throw error
  }
  fs.closeSync(fd)
}
