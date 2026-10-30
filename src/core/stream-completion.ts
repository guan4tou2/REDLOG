import { capturedContentIsPartial } from './content-contract'

/** What the saved rows of one streamed flow (SSE or WebSocket) can prove
 *  about it. The producer reports what it observed when the stream closed;
 *  RedLog counts what it actually kept. Neither side alone is enough: the
 *  producer cannot know which of its queued segments were saved
 *  (`capture_delivery: "unknown"`), and RedLog cannot know a stream ended if
 *  the producer died before it said so (#291).
 *
 *  - `end-observed`: the close was seen and every segment it reported is saved.
 *  - `known-partial`: the close says it was interrupted, segments were refused
 *    or truncated, or fewer were saved than were observed.
 *  - `completion-unknown`: no close was recorded (`closed: false`). The stream
 *    may still be open, or the producer stopped first; nothing here can tell
 *    those apart. `closed: true` is a close too old to report a count. */
export type StreamCompletion =
  | { state: 'end-observed'; saved: number }
  | { state: 'known-partial'; saved: number; observed?: number; missing?: number }
  | { state: 'completion-unknown'; saved: number; closed: boolean }

export interface StreamSegments {
  /** The newest closing row: `websocket_end`, or a streamed `http_response` / `http_error`. */
  terminal: Record<string, unknown> | null
  /** Distinct `http_response_chunk` seq values saved for the flow. */
  savedChunks: number
  /** Distinct `ws_message` rows saved for the flow. */
  savedMessages: number
}

/** Null when the flow has no stream rows at all: an ordinary request/response. */
export function streamCompletion({ terminal, savedChunks, savedMessages }: StreamSegments): StreamCompletion | null {
  if (!terminal) {
    const saved = savedChunks + savedMessages
    return saved > 0 ? { state: 'completion-unknown', saved, closed: false } : null
  }
  const webSocket = terminal.subtype === 'websocket_end'
  const saved = webSocket ? savedMessages : savedChunks
  const reported = webSocket ? terminal.message_count_observed : terminal.stream_chunks_observed
  const observed = typeof reported === 'number' && Number.isFinite(reported) ? reported : undefined
  if (observed !== undefined && saved < observed) return { state: 'known-partial', saved, observed, missing: observed - saved }
  if (capturedContentIsPartial(terminal)) return { state: 'known-partial', saved }
  if (terminal.stream_state === 'ended' && observed !== undefined) return { state: 'end-observed', saved }
  return { state: 'completion-unknown', saved, closed: true }
}
