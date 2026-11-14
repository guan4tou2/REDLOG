// JSON `\uXXXX` escapes turned back into the characters they stand for, for
// search only. An encoder that escapes non-ASCII (Python's json.dumps and
// requests, PHP's json_encode) writes `中文` as `中文`, and the body
// index tokenizes saved bytes as written, so the word is not in it. The body
// index adds this decoded text beside the saved text (http-body-index.ts);
// stored evidence is never rewritten.
//
// Textual, not a JSON parse: a body is never parsed for this, so its nesting
// depth does not matter, and text that is not JSON at all (a script, a log)
// decodes the same way. Only `\u` followed by four hex digits after an odd run
// of backslashes is an escape: `\\u4e2d` is an escaped backslash and the
// letters `u4e2d`. A high surrogate decodes only together with the low
// surrogate escape right after it. Everything else — other escapes, malformed
// or lone-surrogate sequences, every byte that is not part of a decoded
// escape — is left exactly as it was. A decoded control character (below
// U+0020) becomes a space: the tokenizer separates on it either way, and a
// NUL never reaches the index.
//
// One pass over the input; a backslash run is counted once and never revisited.

const BACKSLASH = 92
const U = 117

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48
  const lower = code | 32
  return lower >= 97 && lower <= 102 ? lower - 87 : -1
}

/** The code unit written as four hex digits at `at`, or -1. */
function codeUnitAt(s: string, at: number): number {
  if (at + 4 > s.length) return -1
  let value = 0
  for (let i = at; i < at + 4; i++) {
    const h = hexValue(s.charCodeAt(i))
    if (h < 0) return -1
    value = value * 16 + h
  }
  return value
}

/** True when what is left of `s` from `at` could still become `\uXXXX`
 *  (`u` false: just the hex digits) once more text arrives. */
function couldComplete(s: string, at: number, withPrefix: boolean): boolean {
  let i = at
  if (withPrefix) {
    if (i < s.length && s.charCodeAt(i) !== BACKSLASH) return false
    i++
    if (i < s.length && s.charCodeAt(i) !== U) return false
    i++
  }
  for (; i < s.length; i++) if (hexValue(s.charCodeAt(i)) < 0) return false
  return true
}

interface Scan { out: string; rest: string; changed: boolean }

/** Decode `s`. Unless `final`, an escape cut off at the end of `s` is not
 *  decided: it comes back as `rest` (at most twelve characters) to be
 *  prefixed to the next piece. */
function scan(s: string, final: boolean): Scan {
  const parts: string[] = []
  let from = 0, i = 0, changed = false
  const held = (at: number): Scan => { parts.push(s.slice(from, at)); return { out: parts.join(''), rest: s.slice(at), changed } }
  for (;;) {
    const start = s.indexOf('\\', i)
    if (start < 0) break
    let k = start
    while (k < s.length && s.charCodeAt(k) === BACKSLASH) k++
    // An even run is escaped backslashes only, whatever follows.
    if ((k - start) % 2 === 0) { i = k; continue }
    const escape = k - 1
    if (k >= s.length) { if (final) break; return held(escape) }
    if (s.charCodeAt(k) !== U) { i = k; continue }
    if (!final && k + 5 > s.length && couldComplete(s, k + 1, false)) return held(escape)
    const unit = codeUnitAt(s, k + 1)
    if (unit < 0) { i = k + 1; continue }
    let end = k + 5
    let decoded: string | null
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (!final && end + 6 > s.length && couldComplete(s, end, true)) return held(escape)
      const low = s.charCodeAt(end) === BACKSLASH && s.charCodeAt(end + 1) === U ? codeUnitAt(s, end + 2) : -1
      if (low >= 0xdc00 && low <= 0xdfff) { decoded = String.fromCharCode(unit, low); end += 6 }
      else decoded = null
    } else if (unit >= 0xdc00 && unit <= 0xdfff) decoded = null
    else decoded = unit < 0x20 ? ' ' : String.fromCharCode(unit)
    i = end
    if (decoded === null) continue
    parts.push(s.slice(from, escape), decoded)
    from = end
    changed = true
  }
  parts.push(s.slice(from))
  return { out: parts.join(''), rest: '', changed }
}

/** `text` with its `\uXXXX` escapes decoded, or null when it has none. */
export function decodeJsonEscapes(text: string): string | null {
  const result = scan(text, true)
  return result.changed ? result.out : null
}

/** The same, for text read in pieces: `push` each piece in order, then `end`.
 *  The concatenated output equals `decodeJsonEscapes` of the whole text,
 *  wherever the pieces were cut. */
export function jsonEscapeDecoder(): { push: (piece: string) => string; end: () => string; readonly changed: boolean } {
  let carry = '', changed = false
  const take = (result: Scan): string => { carry = result.rest; changed ||= result.changed; return result.out }
  return {
    push: piece => take(scan(carry + piece, false)),
    end: () => take(scan(carry, true)),
    get changed() { return changed }
  }
}
