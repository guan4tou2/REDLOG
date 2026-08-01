import { describe, it, expect } from 'vitest'

// Test loot detection patterns without DB dependency

interface LootMatch {
  type: string
  value: string
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

function scanText(text: string): LootMatch[] {
  const matches: LootMatch[] = []
  for (const { type, pattern, confidence } of LOOT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const value = m[1] || m[0]
      matches.push({ type, value: value.slice(0, 500), confidence })
    }
  }
  return matches
}

describe('loot pattern detection', () => {
  it('detects $6$ password hashes', () => {
    const matches = scanText('$6$salt$hashvalue123456789')
    expect(matches.some(m => m.type === 'password_hash')).toBe(true)
  })

  it('detects $1$ md5 hashes', () => {
    const matches = scanText('$1$saltsalt$abcdef0123456789')
    expect(matches.some(m => m.type === 'password_hash')).toBe(true)
  })

  it('detects NTLM hashes', () => {
    const matches = scanText('aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0')
    expect(matches.some(m => m.type === 'ntlm_hash')).toBe(true)
  })

  it('detects AWS access keys', () => {
    const matches = scanText('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(matches.some(m => m.type === 'aws_key')).toBe(true)
  })

  it('detects JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456'
    const matches = scanText(`Bearer ${jwt}`)
    expect(matches.some(m => m.type === 'jwt')).toBe(true)
  })

  it('detects RSA private keys', () => {
    const matches = scanText('-----BEGIN RSA PRIVATE KEY-----')
    expect(matches.some(m => m.type === 'private_key')).toBe(true)
  })

  it('detects EC private keys', () => {
    const matches = scanText('-----BEGIN EC PRIVATE KEY-----')
    expect(matches.some(m => m.type === 'private_key')).toBe(true)
  })

  it('detects OPENSSH private keys', () => {
    const matches = scanText('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(matches.some(m => m.type === 'private_key')).toBe(true)
  })

  it('detects postgres database URLs', () => {
    const matches = scanText('DATABASE_URL=postgres://admin:p4ss@db.host:5432/mydb')
    expect(matches.some(m => m.type === 'database_url')).toBe(true)
  })

  it('detects mysql database URLs', () => {
    const matches = scanText('mysql://root:password@localhost/db')
    expect(matches.some(m => m.type === 'database_url')).toBe(true)
  })

  it('detects mongodb URLs', () => {
    const matches = scanText('mongodb://admin:pass@cluster.mongodb.net/test')
    expect(matches.some(m => m.type === 'database_url')).toBe(true)
  })

  it('detects CTF flags', () => {
    const matches = scanText('flag{y0u_f0und_1t_2024}')
    expect(matches.some(m => m.type === 'flag')).toBe(true)
  })

  it('detects HTB flags', () => {
    const matches = scanText('HTB{s3cr3t_fl4g_h3r3}')
    expect(matches.some(m => m.type === 'flag')).toBe(true)
  })

  it('detects shadow file entries', () => {
    const matches = scanText('root:$6$xyz$hash:19000:0:99999:7:::')
    expect(matches.some(m => m.type === 'shadow_entry')).toBe(true)
  })

  it('detects generic API keys', () => {
    const matches = scanText('api_key=sk_live_abcdefghijklmnop')
    expect(matches.some(m => m.type === 'generic_api_key')).toBe(true)
  })

  it('detects Basic auth headers', () => {
    const matches = scanText('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    expect(matches.some(m => m.type === 'base64_creds')).toBe(true)
  })

  it('returns empty for clean text', () => {
    const matches = scanText('Hello world, this is a normal log line with no secrets.')
    expect(matches.length).toBe(0)
  })

  it('detects multiple types in one text', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE\nflag{test}\npostgres://root:x@db/y'
    const matches = scanText(text)
    const types = new Set(matches.map(m => m.type))
    expect(types.has('aws_key')).toBe(true)
    expect(types.has('flag')).toBe(true)
    expect(types.has('database_url')).toBe(true)
  })
})

// The LootDetector class + plugin-pattern registry live in the real module.
// These tests exercise the code paths the pattern-only tests above cannot cover:
//   • per-instance dedup (same value seen twice → one match)
//   • operatorId gate: scan() must not touch the DB when unconfigured
//   • register/unregister lifecycle for plugin-contributed patterns
//   • malformed plugin regex is skipped, not thrown
import { LootDetector, registerLootPatterns, unregisterLootPatterns } from '../src/core/loot-detector'
import { afterEach } from 'vitest'

describe('LootDetector class', () => {
  afterEach(() => {
    unregisterLootPatterns('plug-a')
    unregisterLootPatterns('plug-b')
    unregisterLootPatterns('bad-plug')
  })

  it('scan() without operatorId does not attempt to insert events (safe pre-DB)', () => {
    const d = new LootDetector()
    // operatorId is empty → the insertEvent path is skipped, so no throw even
    // though there's no DB configured in this test file.
    const m = d.scan('AKIAIOSFODNN7EXAMPLE')
    expect(m.some((x) => x.type === 'aws_key')).toBe(true)
    expect(d.getLootCount()).toBeGreaterThan(0)
  })

  it('deduplicates: the same value scanned twice yields one match total', () => {
    const d = new LootDetector()
    const text = 'AKIAIOSFODNN7EXAMPLE somewhere'
    const first = d.scan(text)
    const second = d.scan(text)
    expect(first.length).toBe(1)
    expect(second.length).toBe(0)
    expect(d.getLootCount()).toBe(1)
  })

  it('separate instances have independent dedup sets', () => {
    const a = new LootDetector()
    const b = new LootDetector()
    const text = 'AKIAIOSFODNN7EXAMPLE'
    expect(a.scan(text).length).toBe(1)
    expect(b.scan(text).length).toBe(1)
  })

  it('empty text returns no matches and does not throw', () => {
    const d = new LootDetector()
    expect(d.scan('')).toEqual([])
    expect(d.getLootCount()).toBe(0)
  })

  it('plugin patterns are added and honored, then removed by unregister', () => {
    const d = new LootDetector()
    const added = registerLootPatterns('plug-a', [
      { type: 'acme_token', pattern: 'ACME-[0-9]{8}', confidence: 'high' }
    ])
    expect(added).toBe(1)
    const first = d.scan('log line ACME-12345678 tail')
    expect(first.some((m) => m.type === 'acme_token')).toBe(true)

    unregisterLootPatterns('plug-a')
    const d2 = new LootDetector()
    const second = d2.scan('log line ACME-99999999 tail')
    expect(second.some((m) => m.type === 'acme_token')).toBe(false)
  })

  it('bad plugin regex is silently skipped (count reflects only compiled patterns)', () => {
    const added = registerLootPatterns('bad-plug', [
      { type: 'broken', pattern: '[unterminated', confidence: 'low' },
      { type: 'works', pattern: 'WORKS-\\d+', confidence: 'high' }
    ])
    expect(added).toBe(1)
    const d = new LootDetector()
    const m = d.scan('event WORKS-42 done')
    expect(m.some((x) => x.type === 'works')).toBe(true)
  })

  it('plugin patterns default to global flag (finds every occurrence)', () => {
    registerLootPatterns('plug-b', [
      { type: 'twin', pattern: 'TWIN-[a-z]+', confidence: 'medium' }
    ])
    const d = new LootDetector()
    // Two different values → both matched, both deduped independently.
    const m = d.scan('TWIN-alpha and TWIN-beta and TWIN-alpha again')
    const values = m.filter((x) => x.type === 'twin').map((x) => x.value)
    expect(new Set(values).size).toBe(2)
  })
})
