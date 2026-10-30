import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { queryStreamSegments } from '../src/core/db/events'
import { streamCompletion } from '../src/core/stream-completion'
import { addExportEvent } from './helpers/export-fixtures'

// #291: the counts behind "stream ended / segments missing / no end recorded"
// come from what the database kept, deduplicated the way retries arrive.

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-segments-')); initDB(dir) })
afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

const row = (id: string, ts: number, subtype: string, data: Record<string, unknown>) =>
  addExportEvent('events_logged', id, ts, { agentType: 'scanner', subtype, data })
const completionOf = (flowId: string) => streamCompletion(queryStreamSegments(flowId))

describe('stream segments a flow kept', () => {
  it('reads a killed SSE producer as no end recorded', () => {
    row('req', 1000, 'http_request_start', { flow_id: 'sse', url: 'https://a.test/events' })
    row('c1', 1001, 'http_response_chunk', { flow_id: 'sse', seq: 1, streamed: true })
    row('c2', 1002, 'http_response_chunk', { flow_id: 'sse', seq: 2, streamed: true })
    expect(completionOf('sse')).toEqual({ state: 'completion-unknown', saved: 2, closed: false })
  })

  it('counts a retried chunk once, and confirms the end when the close agrees', () => {
    row('c1', 1001, 'http_response_chunk', { flow_id: 'sse', seq: 1, streamed: true })
    row('c1-retry', 1001, 'http_response_chunk', { flow_id: 'sse', seq: 1, streamed: true })
    row('c2', 1002, 'http_response_chunk', { flow_id: 'sse', seq: 2, streamed: true })
    row('resp', 1003, 'http_response', { flow_id: 'sse', streamed: true, stream_state: 'ended', stream_chunks_observed: 2, stream_not_queued_bytes: 0 })
    expect(completionOf('sse')).toEqual({ state: 'end-observed', saved: 2 })
  })

  it('names the chunks a close reported that the database never kept', () => {
    row('c1', 1001, 'http_response_chunk', { flow_id: 'sse', seq: 1, streamed: true })
    row('resp', 1003, 'http_response', { flow_id: 'sse', streamed: true, stream_state: 'ended', stream_chunks_observed: 4, stream_not_queued_bytes: 0 })
    expect(completionOf('sse')).toEqual({ state: 'known-partial', saved: 1, observed: 4, missing: 3 })
  })

  it('judges a WebSocket by messages and its own close', () => {
    for (let n = 1; n <= 3; n++) row(`m${n}`, 1000 + n, 'ws_message', { flow_id: 'ws', message_count: n })
    row('m3-retry', 1003, 'ws_message', { flow_id: 'ws', message_count: 3 })
    expect(completionOf('ws')).toEqual({ state: 'completion-unknown', saved: 3, closed: false })
    row('end', 1010, 'websocket_end', { flow_id: 'ws', streamed: true, stream_state: 'ended', close_code: 1000, message_count_observed: 3, stream_not_queued_bytes: 0, truncated: false })
    expect(completionOf('ws')).toEqual({ state: 'end-observed', saved: 3 })
  })

  it('takes the newest close when a flow has more than one', () => {
    row('c1', 1001, 'http_response_chunk', { flow_id: 'sse', seq: 1, streamed: true })
    row('resp', 1003, 'http_response', { flow_id: 'sse', streamed: true, stream_state: 'ended', stream_chunks_observed: 1 })
    row('err', 1004, 'http_error', { flow_id: 'sse', streamed: true, stream_state: 'interrupted', stream_chunks_observed: 1 })
    expect(completionOf('sse')).toEqual({ state: 'known-partial', saved: 1 })
  })

  it('says nothing about an ordinary request and response', () => {
    row('req', 1000, 'http_request_start', { flow_id: 'plain' })
    row('resp', 1001, 'http_response', { flow_id: 'plain', status: 200 })
    expect(completionOf('plain')).toBeNull()
  })

  it('reads through the stream index, not a scan of every scanner row', () => {
    const plan = getDB().prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events_logged
      WHERE agent_type = 'scanner' AND subtype IN ('http_response_chunk', 'ws_message', 'websocket_end', 'http_error')
        AND json_extract(data, '$.flow_id') = ?`).all('sse') as Array<{ detail: string }>
    expect(plan.map(step => step.detail).join(' ')).toContain('idx_events_logged_stream_flow')
  })
})
