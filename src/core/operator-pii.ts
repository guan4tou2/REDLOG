import os from 'os'

// Operator PII scrubbing — replaces identifiers that reveal the operator's
// real-world identity (OS home path, account username, machine hostname) in
// serialized export strings. Originally NDJSON-only; now shared across all
// export paths when "Scrub PII" is on.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SHORT_ESCAPE: Record<number, string> = { 8: 'b', 9: 't', 10: 'n', 12: 'f', 13: 'r' }

// The text this runs over is serialised JSON, and the same identifier can sit
// at any depth of escaping in it: a string field is escaped once, a string
// that holds JSON text (a request body, an MCP input, a container the writer
// collapsed, Spec 071 FR-097) once more, and so on. At escaping level k a
// backslash is 2^k backslashes, a quote is 2^k − 1 backslashes and the quote,
// a control character is 2^(k−1) backslashes and its short or \u00XX escape.
// So each character JSON escapes matches a run of backslashes in front of its
// escaped form, which is level-independent and never runs past the
// identifier's own last character.
//
// Linear time, on any text. Two quantified backslash pieces side by side
// (`\\+\\+`, or `\\+` then `\\*"`) can split one run of backslashes in as many
// ways as it is long, and a pattern that starts with one is retried at every
// backslash of the run: cubic on a run of millions. So the pieces are built per
// run, not per character — a run of backslashes is one `\\+`, and the quote or
// control character that follows it is folded into that same piece — and a
// pattern that starts with a backslash may only start where a run starts.
function piecesOf(s: string): string[] {
  const out: string[] = []
  const chars = Array.from(s)
  for (let i = 0; i < chars.length;) {
    const c = chars[i]
    const code = c.charCodeAt(0)
    if (c === '\\') {
      while (chars[i] === '\\') i++
      const next = chars[i]
      if (next === '"') { out.push('\\\\+"'); i++ }
      else if (next !== undefined && next.charCodeAt(0) < 0x20) { out.push(`\\\\+(?:${escapeRegExp(next)}|${escapedForm(next.charCodeAt(0))})`); i++ }
      else out.push('\\\\+')
      continue
    }
    if (c === '"') out.push('\\\\*"')
    else if (code < 0x20) out.push(`(?:${escapeRegExp(c)}|\\\\+${escapedForm(code)})`)
    else out.push(escapeRegExp(c))
    i++
  }
  return out
}

/** A control character's escape after its backslashes: `n`, or `u000a`. */
function escapedForm(code: number): string {
  const short = SHORT_ESCAPE[code]
  return `(?:${short ? `${short}|` : ''}u${code.toString(16).padStart(4, '0')})`
}

/** A pattern that matches `s` at every level of JSON escaping. */
function literalAtAnyEscaping(s: string): string {
  const pieces = piecesOf(s)
  // A leading run of backslashes (a UNC home, `\\srv\share\jo`) starts only
  // where a run of backslashes starts: anywhere inside one it is retried for
  // every backslash of it.
  return (s.startsWith('\\') ? '(?<!\\\\)' : '') + pieces.join('')
}

// A word boundary for the user name that also holds after an escape sequence
// ending in a letter (`\n`, `\u00e9`): in serialised text `line\nalice` the `n`
// of the escape stands before `alice`.
//
// Two over-scrubs are deliberate, erring towards removing the operator's name:
// - a folder whose name starts with one of those letters after a backslash is
//   read as an escape: `C:\nalice` (a folder `nalice`) becomes `C:\n<user>`;
// - the boundary is ASCII: a name in a script without word spaces is matched
//   inside a longer run, so user 王小明 scrubs `他說王小明天要來` to
//   `他說<user>天要來`.
const BEFORE_WORD = '(?:(?<![A-Za-z0-9_])|(?<=\\\\[bfnrt])|(?<=\\\\u[0-9a-fA-F]{4}))'
// After the home path too: home `C:\Users\Jo` is not the start of
// `C:\Users\Joanna` (which read `<home>anna` before this boundary was added).
const AFTER_WORD = '(?![A-Za-z0-9_])'

/** Build regex replacements for the running machine's identifiers. Each one
 *  matches at any level of JSON escaping (see piecesOf). */
export function operatorPiiReplacements(
  ids: { home?: string; user?: string; host?: string } = {}
): Array<[RegExp, string]> {
  const home = ids.home ?? os.homedir()
  const user = ids.user ?? os.userInfo().username
  const host = ids.host ?? os.hostname()
  const reps: Array<[RegExp, string]> = []
  if (home) reps.push([new RegExp(literalAtAnyEscaping(home) + AFTER_WORD, 'g'), '<home>'])
  if (host) reps.push([new RegExp(literalAtAnyEscaping(host), 'g'), '<host>'])
  if (user && user.length >= 3) reps.push([new RegExp(BEFORE_WORD + literalAtAnyEscaping(user) + AFTER_WORD, 'g'), '<user>'])
  return reps
}

/** Apply operator PII replacements to a serialized string. */
export function scrubOperatorPii(text: string, reps?: Array<[RegExp, string]>): string {
  const r = reps ?? operatorPiiReplacements()
  for (const [re, rep] of r) text = text.replace(re, rep)
  return text
}
