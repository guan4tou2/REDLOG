import os from 'os'

// Operator PII scrubbing — replaces identifiers that reveal the operator's
// real-world identity (OS home path, account username, machine hostname) in
// serialized export strings. Originally NDJSON-only; now shared across all
// export paths when the "For sharing" preset is active.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build regex replacements for the running machine's identifiers. */
export function operatorPiiReplacements(
  ids: { home?: string; user?: string; host?: string } = {}
): Array<[RegExp, string]> {
  const home = ids.home ?? os.homedir()
  const user = ids.user ?? os.userInfo().username
  const host = ids.host ?? os.hostname()
  const reps: Array<[RegExp, string]> = []
  if (home) {
    reps.push([new RegExp(escapeRegExp(home), 'g'), '<home>'])
    if (home.includes('\\')) reps.push([new RegExp(escapeRegExp(home.replace(/\\/g, '\\\\')), 'g'), '<home>'])
  }
  if (host) reps.push([new RegExp(escapeRegExp(host), 'g'), '<host>'])
  if (user && user.length >= 3) reps.push([new RegExp('\\b' + escapeRegExp(user) + '\\b', 'g'), '<user>'])
  return reps
}

/** Apply operator PII replacements to a serialized string. */
export function scrubOperatorPii(text: string, reps?: Array<[RegExp, string]>): string {
  const r = reps ?? operatorPiiReplacements()
  for (const [re, rep] of r) text = text.replace(re, rep)
  return text
}
