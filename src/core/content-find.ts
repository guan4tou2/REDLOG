// "Find in content": the next place a needle is in saved text, as a byte range
// of the saved bytes, read in bounded windows.
//
// The rule: a needle matches where the saved bytes hold it as written, or —
// in a field whose body-index entry is decoded (ESCAPE_DECODED_BODY_FIELDS) —
// where the text holds it once its `\uXXXX` escapes are read as the
// characters they name. The escapes are the ones json-escape-text.ts decodes
// for the index (four hex digits after an odd run of backslashes; a high
// surrogate only with the low surrogate escape right after it), except that
// an escape naming a control character (below U+0020) is left as written:
// the index turns it into a space for its tokenizer, and a needle `a b`
// matching `a\u000ab` would be a surprise. No other escape is read (`\n`,
// `\"`, `\\`, `\/` stay as written), case is exact, and the content is never
// parsed. The two readings are separate: a match is all as written or all
// read, so a needle never mixes typed escape text with decoded characters.
// At one offset the shorter range wins.
//
// One pass over the bytes, in steps that the escape rules make unambiguous:
// a character as written, a pair of backslashes, or one whole escape (6
// bytes, 12 for a surrogate pair). Two KMP automata run over it, one on
// bytes and one on the characters the steps read, so the work is linear
// whatever the content is (a run of backslashes, `\u` and garbage). A step
// needs at most 12 bytes ahead. Where a step begins, the scan needs nothing
// from before it; that is why a continuation carries `from`, the step start
// at or before its offset (at most 11 bytes back): a backslash's meaning
// depends on the whole run before it, which may be megabytes long.

const BACKSLASH = 92
const U = 117
/** Bytes a step may need: a surrogate pair written as two escapes. */
const STEP = 12

/** Where a search continues: matches begin at or after `offset`; the scan
 *  resumes at `from`, a step start no more than 11 bytes before it. */
export interface FindPosition { offset: number; from: number }
export interface FindScan {
  match: { offset: number; bytes: number } | null
  /** The position the next call continues from: after the match, or at the
   *  end of this call's budget. */
  next: FindPosition
  /** Bytes read from the source, and loop iterations, by this call. */
  examined: number
  work: number
}
/** The longest a valid continuation's `from` may sit before its offset. */
export const MAX_RESUME_BACK = STEP - 1

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48
  const lower = code | 32
  return lower >= 97 && lower <= 102 ? lower - 87 : -1
}

function failureTable(units: ArrayLike<number>): Int32Array {
  const fail = new Int32Array(units.length)
  for (let i = 1, k = 0; i < units.length; i++) {
    while (k > 0 && units[i] !== units[k]) k = fail[k - 1]
    if (units[i] === units[k]) k++
    fail[i] = k
  }
  return fail
}

/** Search `[at.offset, at.offset + budget)` for the start of a match.
 *  `decode`: also match the needle's characters read from escapes. */
export function findInSavedText(read: (offset: number, length: number) => Buffer, total: number, needle: string, at: FindPosition, budget: number, decode: boolean, window = 65536): FindScan {
  const needleBytes = Buffer.from(needle, 'utf8'), n = needleBytes.length
  const points = Array.from(needle, ch => ch.codePointAt(0)!), m = points.length
  const byteFail = failureTable(needleBytes), pointFail = failureTable(points)
  // The longest saved range a match can cover: every character escaped.
  let span = n
  if (decode) { span = 0; for (const p of points) span += p > 0xffff ? 12 : 6 }
  const minStart = at.offset
  const through = Math.min(total, minStart + budget)
  // A match starting before `through` ends before this.
  const scanEnd = Math.min(total, through + span)
  let buf: Buffer = Buffer.alloc(0), bufStart = at.from, examined = 0, work = 0
  const have = (): number => bufStart + buf.length
  type Found = { offset: number; bytes: number; from: number }
  let best = null as Found | null
  const consider = (start: number, end: number, from: number): void => {
    if (start < minStart || start >= through) return
    if (!best || start < best.offset || (start === best.offset && end - start < best.bytes)) best = { offset: start, bytes: end - start, from }
  }
  let byteState = 0, pointState = 0, pointIndex = 0
  const starts = new Float64Array(Math.max(1, m))
  // Where the next call resumes after a match ending at `end` inside the step
  // [stepStart, stepEnd): the next step when the match ends with this one.
  const feed = (value: number, start: number, end: number, stepStart: number, stepEnd: number): void => {
    if (start < minStart) return
    work++
    while (pointState > 0 && points[pointState] !== value) { pointState = pointFail[pointState - 1]; work++ }
    starts[pointIndex++ % m] = start
    if (points[pointState] === value) pointState++
    if (pointState === m) { consider(starts[(pointIndex - m) % m], end, end === stepEnd ? stepEnd : stepStart); pointState = pointFail[m - 1] }
  }
  let pos = at.from, resume = at.from
  while (pos < scanEnd) {
    if (best && pos >= best.offset + span) break
    work++
    if (pos <= through) resume = pos
    if (pos + STEP > have() && have() < total) {
      const length = Math.min(total - pos, Math.max(STEP, Math.min(window, scanEnd + STEP - pos)))
      buf = read(pos, length); bufStart = pos; examined += buf.length
    }
    const i = pos - bufStart, limit = buf.length, b = buf[i]
    let length = 1, point = -1, pair = false
    if (b === BACKSLASH && decode) {
      if (i + 1 < limit && buf[i + 1] === BACKSLASH) { length = 2; point = BACKSLASH; pair = true }
      else {
        const unit = unitAt(buf, i, limit)
        work += 4
        if (unit >= 0x20 && (unit < 0xd800 || unit > 0xdfff)) { point = unit; length = 6 }
        else if (unit >= 0xd800 && unit <= 0xdbff) {
          const low = unitAt(buf, i + 6, limit)
          work += 4
          if (low >= 0xdc00 && low <= 0xdfff) { point = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00); length = 12 }
          else point = BACKSLASH
        } else point = BACKSLASH
      }
    } else if (b < 0x80) point = b
    else {
      // A character as written. A byte that does not begin a valid UTF-8
      // sequence is a step of its own that no needle character equals.
      const need = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 0
      if (need && i + need <= limit) {
        const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80, hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf
        let value = need === 2 ? b & 0x1f : need === 3 ? b & 0x0f : b & 0x07, ok = buf[i + 1] >= lo && buf[i + 1] <= hi
        for (let k = 1; ok && k < need; k++) { const c = buf[i + k]; if (k > 1 && (c & 0xc0) !== 0x80) ok = false; value = value * 64 + (c & 0x3f) }
        work += need
        if (ok) { point = value; length = need }
      }
    }
    const stepEnd = pos + length
    for (let k = pos; k < stepEnd; k++) {
      if (k < minStart) continue
      const c = buf[k - bufStart]
      work++
      while (byteState > 0 && needleBytes[byteState] !== c) { byteState = byteFail[byteState - 1]; work++ }
      if (needleBytes[byteState] === c) byteState++
      if (byteState === n) { consider(k + 1 - n, k + 1, k + 1 === stepEnd ? stepEnd : pos); byteState = byteFail[n - 1] }
    }
    if (decode) {
      if (pair) { feed(BACKSLASH, pos, pos + 1, pos, stepEnd); feed(BACKSLASH, pos + 1, pos + 2, pos, stepEnd) }
      else feed(point, pos, stepEnd, pos, stepEnd)
    }
    pos = stepEnd
  }
  if (pos <= through) resume = pos
  if (best) return { match: { offset: best.offset, bytes: best.bytes }, next: { offset: best.offset + best.bytes, from: best.from }, examined, work }
  return { match: null, next: { offset: through, from: resume }, examined, work }
}

/** The code unit `\uXXXX` at `i` writes, or -1. */
function unitAt(buf: Buffer, i: number, limit: number): number {
  if (i + 6 > limit || buf[i] !== BACKSLASH || buf[i + 1] !== U) return -1
  let value = 0
  for (let k = i + 2; k < i + 6; k++) {
    const h = hexDigit(buf[k])
    if (h < 0) return -1
    value = value * 16 + h
  }
  return value
}
