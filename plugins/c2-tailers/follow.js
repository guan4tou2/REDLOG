// c2-tailers — where the follower reads from, and how far a read may advance.
// Pure and dependency-free so the offset rules are unit-tested
// (test/c2-tailers.test.ts) without a file, a timer or a running RedLog.
'use strict'

/** Where to begin on a file. An existing log is history the operator did not
 *  ask to import, so the default is its end; `--from-start` opts in. A file
 *  that does not exist yet is all new, so it is read from 0 once it appears. */
function initialOffset(size, fromStart) {
  if (fromStart || size == null) return 0
  return size
}

/** Restart from 0 when the file is no longer the one being followed: it
 *  shrank (truncated) or its inode changed (rotated and recreated). */
function resyncOffset(offset, stat, lastIno) {
  if (stat.size < offset) return 0
  if (lastIno != null && stat.ino != null && stat.ino !== lastIno) return 0
  return offset
}

/** Complete lines in `buf` with the byte offset just past each one's newline.
 *  A trailing line without a newline is still being written and is left out. */
function completeLines(buf) {
  const out = []
  let start = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, start)
    if (nl === -1) break
    out.push({ line: buf.subarray(start, nl).toString('utf8'), end: nl + 1 })
    start = nl + 1
  }
  return out
}

/** Post the complete lines of `buf` (read at `baseOffset`) in order and
 *  return the offset to resume from. A line advances the offset only once it
 *  is posted, rejected for good, or not an event at all; the first post that
 *  should be retried stops the drain there, so that line and everything after
 *  it are read again next tick.
 *    post(ev) → 'ok' | 'drop' | 'retry' */
async function drainLines(buf, baseOffset, parse, post) {
  let offset = baseOffset
  let posted = 0
  let dropped = 0
  for (const { line, end } of completeLines(buf)) {
    const ev = parse(line)
    if (ev) {
      const result = await post(ev)
      if (result === 'retry') return { offset, posted, dropped, stalled: true }
      if (result === 'ok') posted++
      else dropped++
    }
    offset = baseOffset + end
  }
  return { offset, posted, dropped, stalled: false }
}

/** Classify an HTTP outcome. A refused event (4xx) will be refused again, so
 *  retrying it would stall the follower on that line forever; auth, timeout
 *  and rate-limit refusals and every 5xx are worth another try. */
function postOutcome(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 408 || status === 429) return 'retry'
  if (status >= 400 && status < 500) return 'drop'
  return 'retry'
}

module.exports = { initialOffset, resyncOffset, completeLines, drainLines, postOutcome }
