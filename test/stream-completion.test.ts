import { describe, expect, it } from 'vitest'
import { streamCompletion } from '../src/core/stream-completion'

// #291: forced termination must read as unknown, not as complete. Each case is
// a row shape the mitmproxy addon actually writes.
const sseEnd = (extra: Record<string, unknown> = {}) => ({
  subtype: 'http_response', streamed: true, stream_state: 'ended', stream_chunks_observed: 3,
  stream_not_queued_bytes: 0, capture_delivery: 'unknown', ...extra
})
const wsEnd = (extra: Record<string, unknown> = {}) => ({
  subtype: 'websocket_end', streamed: true, stream_state: 'ended', close_code: 1000,
  message_count_observed: 4, stream_not_queued_bytes: 0, truncated: false, capture_delivery: 'unknown', ...extra
})

describe('stream completion from saved rows', () => {
  it('is not a stream when there is neither a close nor a segment', () => {
    expect(streamCompletion({ terminal: null, savedChunks: 0, savedMessages: 0 })).toBeNull()
  })

  it('calls a stream with segments and no close unknown, never complete', () => {
    // The producer was killed mid-stream: chunks arrived, the close never did.
    expect(streamCompletion({ terminal: null, savedChunks: 5, savedMessages: 0 })).toEqual({ state: 'completion-unknown', saved: 5, closed: false })
    expect(streamCompletion({ terminal: null, savedChunks: 0, savedMessages: 2 })).toEqual({ state: 'completion-unknown', saved: 2, closed: false })
  })

  it('confirms an SSE end only when every observed chunk was saved', () => {
    expect(streamCompletion({ terminal: sseEnd(), savedChunks: 3, savedMessages: 0 })).toEqual({ state: 'end-observed', saved: 3 })
  })

  it('counts the chunks that never reached the database as missing', () => {
    // A queue-full refusal or a pause both leave this shape.
    expect(streamCompletion({ terminal: sseEnd(), savedChunks: 1, savedMessages: 0 }))
      .toEqual({ state: 'known-partial', saved: 1, observed: 3, missing: 2 })
  })

  it('treats an interrupted close or unqueued bytes as partial even with every chunk saved', () => {
    expect(streamCompletion({ terminal: sseEnd({ stream_state: 'interrupted' }), savedChunks: 3, savedMessages: 0 }))
      .toEqual({ state: 'known-partial', saved: 3 })
    expect(streamCompletion({ terminal: sseEnd({ stream_not_queued_bytes: 10 }), savedChunks: 3, savedMessages: 0 }))
      .toEqual({ state: 'known-partial', saved: 3 })
  })

  it('reads a streamed http_error as partial', () => {
    expect(streamCompletion({ terminal: { subtype: 'http_error', streamed: true, stream_state: 'interrupted', stream_chunks_observed: 2 }, savedChunks: 2, savedMessages: 0 }))
      .toEqual({ state: 'known-partial', saved: 2 })
  })

  it('judges a WebSocket by its messages, not by chunks', () => {
    expect(streamCompletion({ terminal: wsEnd(), savedChunks: 0, savedMessages: 4 })).toEqual({ state: 'end-observed', saved: 4 })
    expect(streamCompletion({ terminal: wsEnd(), savedChunks: 9, savedMessages: 3 }))
      .toEqual({ state: 'known-partial', saved: 3, observed: 4, missing: 1 })
    expect(streamCompletion({ terminal: wsEnd({ close_code: 1006, stream_state: 'interrupted' }), savedChunks: 0, savedMessages: 4 }))
      .toEqual({ state: 'known-partial', saved: 4 })
    expect(streamCompletion({ terminal: wsEnd({ truncated: true }), savedChunks: 0, savedMessages: 4 }))
      .toEqual({ state: 'known-partial', saved: 4 })
  })

  it('does not confirm a close that reports no count to check against', () => {
    // Rows written before the addon reported observed counts.
    expect(streamCompletion({ terminal: { subtype: 'http_response', streamed: true, stream_state: 'ended' }, savedChunks: 3, savedMessages: 0 }))
      .toEqual({ state: 'completion-unknown', saved: 3, closed: true })
  })
})
