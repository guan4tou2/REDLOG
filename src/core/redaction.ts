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

export function configureRedaction(rules: Partial<RedactionRules>): void {
  activeRules = { ...activeRules, ...rules }
}

export function getRules(): RedactionRules {
  return { ...activeRules }
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
  text: string
  redacted: Array<{ pattern: 'entropy' | 'denylist'; hint: string; start: number; end: number }>
}

export function redact(text: string, rules: RedactionRules = activeRules): RedactionResult {
  if (!text) return { text, redacted: [] }
  const redacted: RedactionResult['redacted'] = []
  const out = text.replace(TOKEN_RE, (token, offset: number) => {
    if (matchesAny(rules.allowlist, token)) return token
    if (matchesAny(rules.denylist, token)) {
      redacted.push({ pattern: 'denylist', hint: `${token.length} chars`, start: offset, end: offset + token.length })
      return '[REDACTED_DENY]'
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
        return `[REDACTED_ENTROPY_${entropy.toFixed(1)}]`
      }
    }
    return token
  })
  return { text: out, redacted }
}
