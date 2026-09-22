// The one interpretation of a typed event query (Spec 017).
//
// Search reads its query string in SQL; the Transcript filters loaded blocks in
// the renderer. Neither can express "this session" or "this tool call". This
// module is the single place that decides what typed text means, so a query
// learned on one surface means the same thing on the other (Spec 018 moves
// Search onto it).
//
// Parsing is deliberately forgiving in one direction and strict in the other.
// An unrecognised prefix stays literal text, because operators paste URLs and
// `https://example.com` must not be read as a condition on a field named
// `https`. A *recognised* field with no value is an error rather than text,
// because `session:` is unambiguously a half-typed condition and silently
// demoting it to a search term would answer a question the operator did not
// ask — the kind of quiet narrowing that turns an empty result into a wrong
// conclusion about absence.

/** Fields that resolve against a stored value rather than matching text. */
export type QueryField = 'event' | 'session' | 'transcript' | 'tool'

export const QUERY_FIELDS: readonly QueryField[] = ['event', 'session', 'transcript', 'tool']

export interface QueryCondition {
  field: QueryField
  value: string
}

/** How one whitespace-separated token of the input was read. */
export interface ParsedToken {
  raw: string
  read: 'condition' | 'text'
}

export interface ParsedQuery {
  /**
   * Conditions resolve against their stored field. A condition is never
   * satisfied by its value merely appearing somewhere in a record's text —
   * the FTS tables index `data` as one blob, so an ID quoted inside unrelated
   * command output would otherwise count as a match.
   */
  conditions: QueryCondition[]
  /** Everything not read as a condition, as one free-text query. */
  text: string
  /** Every token in input order, so a surface can show how it parsed. */
  tokens: ParsedToken[]
}

/**
 * A recognised prefix becomes a condition, which would otherwise make
 * `event:abc` — "which records quote this id", the way an operator finds where
 * an identifier was pasted — unaskable. Double quotes make a token literal
 * text, and may contain whitespace, so the escape and a phrase are one
 * spelling. Unquoted text is unchanged.
 */
export type ParseFailure = 'empty-condition-value' | 'unterminated-quote'

export type ParseOutcome =
  | { ok: true; parsed: ParsedQuery }
  | { ok: false; reason: ParseFailure; token: string }

const FIELD_BY_NAME = new Map<string, QueryField>(QUERY_FIELDS.map((f) => [f, f]))

/** Splits on whitespace, but a double-quoted run stays one token, spaces included. */
function tokenize(input: string): { tokens: string[] } | { unterminated: string } {
  const tokens: string[] = []
  let i = 0
  while (i < input.length) {
    if (/\s/.test(input[i])) { i += 1; continue }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1)
      if (end === -1) return { unterminated: input.slice(i) }
      tokens.push(input.slice(i, end + 1))
      i = end + 1
      continue
    }
    let end = i
    while (end < input.length && !/\s/.test(input[end])) end += 1
    tokens.push(input.slice(i, end))
    i = end
  }
  return { tokens }
}

export function parseQuery(input: string): ParseOutcome {
  const scan = tokenize(input)
  if ('unterminated' in scan) {
    return { ok: false, reason: 'unterminated-quote', token: scan.unterminated }
  }

  const conditions: QueryCondition[] = []
  const textParts: string[] = []
  const tokens: ParsedToken[] = []

  for (const raw of scan.tokens) {
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      // Quoted: literal text even when it looks like a condition. This is the
      // only way to ask which records quote an identifier once the prefix
      // resolves the record that has it.
      tokens.push({ raw, read: 'text' })
      textParts.push(raw.slice(1, -1))
      continue
    }

    // Only the first colon separates; a value may contain more, and a token
    // starting with one has no field name at all.
    const colon = raw.indexOf(':')
    const name = colon > 0 ? raw.slice(0, colon).toLowerCase() : null
    const field = name ? FIELD_BY_NAME.get(name) : undefined

    if (field === undefined) {
      // An unrecognised prefix is text, so a pasted URL or host:port survives.
      tokens.push({ raw, read: 'text' })
      textParts.push(raw)
      continue
    }

    const value = raw.slice(colon + 1)
    if (!value) {
      // A half-typed condition is not a search term. Demoting it would answer
      // a question the operator did not ask and call the result an absence.
      return { ok: false, reason: 'empty-condition-value', token: raw }
    }
    tokens.push({ raw, read: 'condition' })
    conditions.push({ field, value })
  }

  return { ok: true, parsed: { conditions, text: textParts.join(' '), tokens } }
}
