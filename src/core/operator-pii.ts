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
// So each character JSON escapes matches any run of backslashes in front of
// its escaped form, which is level-independent and never runs past the
// identifier's own last character.
function anyEscaping(c: string): string {
  const code = c.charCodeAt(0)
  if (c === '\\') return '\\\\+'
  if (c === '"') return '\\\\*"'
  if (code < 0x20) {
    const hex = code.toString(16).padStart(4, '0')
    const short = SHORT_ESCAPE[code]
    return `(?:${escapeRegExp(c)}|\\\\+(?:${short ? `${short}|` : ''}u${hex}))`
  }
  return escapeRegExp(c)
}

/** A pattern that matches `s` at every level of JSON escaping. */
function literalAtAnyEscaping(s: string): string {
  return Array.from(s, anyEscaping).join('')
}

// A word boundary for the user name that also holds after an escape sequence
// ending in a letter (`\n`, `\u00e9`): in serialised text `line\nalice` the `n`
// of the escape stands before `alice`. Erring towards scrubbing: a folder whose
// name starts with one of those letters after a backslash (`C:\nalice`) is
// scrubbed too.
const BEFORE_WORD = '(?:(?<![A-Za-z0-9_])|(?<=\\\\[bfnrt])|(?<=\\\\u[0-9a-fA-F]{4}))'
const AFTER_WORD = '(?![A-Za-z0-9_])'

/** Build regex replacements for the running machine's identifiers. Each one
 *  matches at any level of JSON escaping (see anyEscaping). */
export function operatorPiiReplacements(
  ids: { home?: string; user?: string; host?: string } = {}
): Array<[RegExp, string]> {
  const home = ids.home ?? os.homedir()
  const user = ids.user ?? os.userInfo().username
  const host = ids.host ?? os.hostname()
  const reps: Array<[RegExp, string]> = []
  if (home) reps.push([new RegExp(literalAtAnyEscaping(home), 'g'), '<home>'])
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
