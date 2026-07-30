export interface RedactionRules {
  allowlist: string[]
  denylist: string[]
  entropyThreshold: number
  minLength: number
}

export const DEFAULT_RULES: RedactionRules = {
  allowlist: [],
  denylist: [],
  entropyThreshold: 4.5,
  minLength: 20
}

let activeRules: RedactionRules = { ...DEFAULT_RULES }

// Additive plugin layer (🟢 declarative): denylist/allowlist entries contributed
// by plugins, kept per-plugin so they survive config reloads and can be removed
// on disable. Merged into the effective rules at read time.
const pluginRules = new Map<string, { denylist: string[]; allowlist: string[] }>()

export function registerRedactionRules(pluginId: string, rules: { denylist?: string[]; allowlist?: string[] }): void {
  pluginRules.set(pluginId, { denylist: rules.denylist ?? [], allowlist: rules.allowlist ?? [] })
}

export function unregisterRedactionRules(pluginId: string): void {
  pluginRules.delete(pluginId)
}

function effectiveRules(): RedactionRules {
  if (pluginRules.size === 0) return activeRules
  const denylist = [...activeRules.denylist]
  const allowlist = [...activeRules.allowlist]
  for (const r of pluginRules.values()) {
    denylist.push(...r.denylist)
    allowlist.push(...r.allowlist)
  }
  return { ...activeRules, denylist: [...new Set(denylist)], allowlist: [...new Set(allowlist)] }
}

export function configureRedaction(rules: Partial<RedactionRules>): void {
  activeRules = { ...activeRules, ...rules }
}

export function getRules(): RedactionRules {
  return effectiveRules()
}

export function shannonEntropy(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const count of freq.values()) {
    const p = count / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const TOKEN_RE = /[A-Za-z0-9_\-\.\/+=]{16,}/g

function matchesAny(patterns: string[], token: string): boolean {
  for (const p of patterns) {
    if (!p) continue
    if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
      try {
        const re = new RegExp(p.slice(1, -1))
        if (re.test(token)) return true
      } catch { /* invalid regex, ignore */ }
    } else if (token.includes(p)) {
      return true
    }
  }
  return false
}

export interface RedactionResult {
  /** The ORIGINAL text, unchanged. The hash chain closes over this — the four-
   *  layer design (see docs/redaction-design.md) treats capture as immutable and
   *  only sanitizes bytes at export time. Callers that want the masked view
   *  compose it via maskText() from the raw text + spans. */
  text: string
  redacted: Array<{ pattern: 'entropy' | 'denylist'; hint: string; start: number; end: number }>
}

export function redact(text: string, rules: RedactionRules = effectiveRules()): RedactionResult {
  if (!text) return { text, redacted: [] }
  const redacted: RedactionResult['redacted'] = []
  let m: RegExpExecArray | null
  // Clone the regex per call so shared `TOKEN_RE.lastIndex` state can't leak
  // between concurrent redact() calls (the module-level regex has /g).
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags)
  while ((m = re.exec(text)) !== null) {
    const token = m[0]
    const offset = m.index
    if (matchesAny(rules.allowlist, token)) continue
    if (matchesAny(rules.denylist, token)) {
      redacted.push({ pattern: 'denylist', hint: `${token.length} chars`, start: offset, end: offset + token.length })
      continue
    }
    if (token.length >= rules.minLength) {
      const entropy = shannonEntropy(token)
      if (entropy >= rules.entropyThreshold) {
        redacted.push({
          pattern: 'entropy',
          hint: `${token.length} chars, ${entropy.toFixed(2)} bits/char`,
          start: offset,
          end: offset + token.length
        })
      }
    }
  }
  return { text, redacted }
}

/** Compose the masked view — replace each span with `char` repeated span-length
 *  times. Used by the UI (mask-by-default), by clipboard-monitor's preview when
 *  the operator has opted into a stored preview, and by `redlog-cli sanitize`
 *  when writing an export bundle. The source text is never mutated in place —
 *  callers get a new string. */
export function maskText(text: string, spans: RedactionResult['redacted'], char = '•'): string {
  if (!spans.length) return text
  // Assume spans don't overlap (redact() emits non-overlapping matches). Sort
  // by start ascending so a single-pass rebuild is straightforward.
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.start < cursor) continue // defensive: skip overlap with previous
    parts.push(text.slice(cursor, s.start))
    parts.push(char.repeat(Math.max(1, s.end - s.start)))
    cursor = s.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}
