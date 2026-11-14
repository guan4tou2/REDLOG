// A field of `data` (or of a request body) as text, without ever recursing.
//
// `String(x)` and a template literal on an array call Array.prototype.join,
// which recurses through nested arrays: a 5,000-level `[[[…]]]` in `pid`,
// `host`, `method` or `agent_type` overflowed the stack and turned a capture
// into a 500 — after the commit, in two cases (Spec 071 FR-097 review). And a
// non-string where a string is expected (`command: ["id"]`) threw a TypeError
// inside a detector. Every place on the ingest path that turns a sender's
// field into text, a key or a number goes through one of these instead.
//
// A string is itself; a number, boolean or bigint is what `String` makes of it
// — byte for byte what those places produced before. Anything else (object,
// array, null, undefined, symbol, function) is not that field: undefined.

/** The field as text, or undefined when it is not a scalar. */
export function fieldText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return undefined
}

/** `Number(v)` for a scalar, NaN for anything else (Number of an array joins it). */
export function fieldNumber(v: unknown): number {
  if (v !== null && (typeof v === 'object' || typeof v === 'function' || typeof v === 'symbol')) return NaN
  return Number(v)
}
