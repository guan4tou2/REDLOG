import { insertEvent } from './db/events'
import { eventBus } from './event-bus'

interface LootMatch {
  type: string
  value: string
  line: string
  confidence: 'high' | 'medium' | 'low'
}

const LOOT_PATTERNS: Array<{ type: string; pattern: RegExp; confidence: 'high' | 'medium' | 'low' }> = [
  { type: 'password_hash', pattern: /\$[126][\$a-z]*\$[./A-Za-z0-9]+/g, confidence: 'high' },
  { type: 'ntlm_hash', pattern: /[a-fA-F0-9]{32}:[a-fA-F0-9]{32}/g, confidence: 'high' },
  { type: 'private_key', pattern: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----/g, confidence: 'high' },
  { type: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g, confidence: 'high' },
  { type: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, confidence: 'medium' },
  { type: 'generic_api_key', pattern: /(?:api[_-]?key|apikey|token|secret|password)\s*[=:]\s*['"]?([^\s'"]{8,})/gi, confidence: 'medium' },
  { type: 'database_url', pattern: /(?:mysql|postgres|mongodb|redis):\/\/[^\s]+/gi, confidence: 'high' },
  { type: 'shadow_entry', pattern: /^[a-z_][a-z0-9_-]*:\$[^:]+:[^:]*:[^:]*:[^:]*:[^:]*:/gm, confidence: 'high' },
  { type: 'flag', pattern: /(?:flag|ctf|HTB)\{[^}]+\}/gi, confidence: 'high' },
  { type: 'base64_creds', pattern: /(?:Authorization|auth):\s*Basic\s+[A-Za-z0-9+/=]{10,}/gi, confidence: 'medium' },
]

// Plugin-contributed loot patterns (🟢 declarative). Kept separate from the
// built-ins so we can list/replace them without touching the base set.
const externalPatterns: Array<{ type: string; pattern: RegExp; confidence: 'high' | 'medium' | 'low'; pluginId: string }> = []

/** Register loot patterns from a plugin. Invalid regexes are skipped, not thrown. */
export function registerLootPatterns(
  pluginId: string,
  patterns: Array<{ type: string; pattern: string; confidence?: 'high' | 'medium' | 'low'; flags?: string }>
): number {
  let added = 0
  for (const p of patterns) {
    try {
      const flags = new Set(['g', ...(p.flags ?? '').split('')].filter(Boolean))
      const re = new RegExp(p.pattern, [...flags].join(''))
      externalPatterns.push({ type: p.type, pattern: re, confidence: p.confidence ?? 'medium', pluginId })
      added++
    } catch { /* bad regex from plugin — skip */ }
  }
  return added
}

/** Drop all patterns a plugin registered (on disable/reload). */
export function unregisterLootPatterns(pluginId: string): void {
  for (let i = externalPatterns.length - 1; i >= 0; i--) {
    if (externalPatterns[i].pluginId === pluginId) externalPatterns.splice(i, 1)
  }
}

export class LootDetector {
  private engagementId = 'default'
  private operatorId = ''
  private detectedHashes = new Set<string>()

  configure(opts: { engagementId?: string; operatorId?: string }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
  }

  scan(text: string, targetId?: string, source?: string): LootMatch[] {
    const matches: LootMatch[] = []

    for (const { type, pattern, confidence } of [...LOOT_PATTERNS, ...externalPatterns]) {
      const re = new RegExp(pattern.source, pattern.flags)
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const value = m[1] || m[0]
        const key = `${type}:${value.slice(0, 32)}`
        if (this.detectedHashes.has(key)) continue
        this.detectedHashes.add(key)

        const lineStart = text.lastIndexOf('\n', m.index) + 1
        const lineEnd = text.indexOf('\n', m.index)
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200)

        matches.push({ type, value: value.slice(0, 500), line, confidence })
      }
    }

    if (matches.length > 0 && this.operatorId) {
      try {
        const evt = insertEvent('loot', {
          subtype: 'credential_detected',
          matches: matches.map((m) => ({ type: m.type, confidence: m.confidence, preview: m.line })),
          count: matches.length,
          // Optional provenance the caller can attach: the tool/command/host the
          // text came from. Trimmed + capped so a rogue caller can't bloat it.
          ...(source && source.trim() ? { source: source.trim().slice(0, 200) } : {})
        }, {
          engagementId: this.engagementId,
          operatorId: this.operatorId,
          targetId
        })
        if (evt) eventBus.publish(evt)
      } catch { /* DB may not be ready */ }
    }

    return matches
  }

  getLootCount(): number {
    return this.detectedHashes.size
  }
}
