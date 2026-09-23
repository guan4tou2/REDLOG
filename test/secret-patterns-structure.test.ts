// Spec 025 — the shape table's structural guarantees.
//
// The golden test proves behaviour did not change. These prove the structure
// that stops the two consumers drifting again: every shape is defined once,
// both consumers take theirs from the table, and the transcript prefilter
// cannot silently skip a shape that redaction lists.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  SECRET_SHAPES, REDACT_IN_TRANSCRIPTS, DETECT_AS_LOOT, TRANSCRIPT_PREFILTER, compileShape,
  type SecretShapeId
} from '../src/core/secret-patterns'

const ROOT = path.join(__dirname, '..')
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

// One sample per shape. The prefilter test runs every redacted shape's sample
// through it, so a sample that stops matching its own shape fails here first.
// Assembled from fragments: see the note in secret-patterns-golden.test.ts.
const cat = (...parts: string[]): string => parts.join('')
const SAMPLES: Record<SecretShapeId, string> = {
  named_secret_assignment: 'api_key=abcd1234efgh',
  bearer_token: cat('Authorization: Bear', 'er abc.def'),
  aws_access_key: cat('AK', 'IAIOSFODNN7EXAMPLE'),
  prefixed_api_key: cat('sk', '-proj-ABCDEFGHIJKLMNOPQRSTUV'),
  private_key_block: cat('-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIE\n-----END RSA PRIV', 'ATE KEY-----'),
  jwt_three_segment: cat('ey', 'Jabcdefghijk.lmnopqrstuvwx.yz0123456789'),
  github_pat: cat('gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  gitlab_pat: cat('gl', 'pat-ABCDEFGHIJ0123456789'),
  slack_token: cat('xo', 'xb-1234567890-abcdefghij'),
  npm_token: cat('np', 'm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  huggingface_token: cat('h', 'f_ABCDEFGHIJKLMNOPQRSTUV'),
  google_oauth_client_secret: cat('GOC', 'SPX-abcDEF_123'),
  uri_userinfo_credentials: cat('postgres://', 'admin', ':', 's3cret', '@db.internal/app'),
  der_base64_key: 'MII' + 'A'.repeat(120),
  crypt_password_hash: '$6$salt$abcdefghijklmnop',
  ntlm_hash_pair: 'aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0',
  private_key_header: cat('-----BEGIN OPENSSH PRIV', 'ATE KEY-----'),
  jwt_with_json_payload: cat('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiIxIn0.sig'),
  named_secret_value: 'apikey = "longsecretvalue123"',
  database_url: 'mongodb://cluster.local/db',
  shadow_entry: 'root:$6$xyz$hash:19000:0:99999:7:::',
  basic_auth_header: cat('Authorization: Bas', 'ic ', Buffer.from('admin:' + 'pass').toString('base64'))
}

describe('the secret shape table', () => {
  it('has a sample for every shape, and each sample matches its shape', () => {
    for (const id of Object.keys(SECRET_SHAPES) as SecretShapeId[]) {
      expect({ id, matches: compileShape(id).test(SAMPLES[id]) }).toEqual({ id, matches: true })
    }
  })

  it('has no shape that no consumer uses', () => {
    const used = new Set<string>([
      ...REDACT_IN_TRANSCRIPTS.map((r) => r.shape),
      ...DETECT_AS_LOOT.map((l) => l.shape)
    ])
    expect(Object.keys(SECRET_SHAPES).filter((id) => !used.has(id))).toEqual([])
  })

  it('lets every redacted shape through the transcript prefilter', () => {
    // A shape listed for redaction but missing from the prefilter's markers
    // would be skipped for every input, and nothing would say so.
    for (const { shape } of REDACT_IN_TRANSCRIPTS) {
      expect({ shape, passes: TRANSCRIPT_PREFILTER.test(SAMPLES[shape]) }).toEqual({ shape, passes: true })
    }
  })

  it('hands each caller its own RegExp, so lastIndex never leaks between them', () => {
    const a = compileShape('aws_access_key')
    const b = compileShape('aws_access_key')
    expect(a).not.toBe(b)
    expect(a).not.toBe(SECRET_SHAPES.aws_access_key.pattern)
  })
})

describe('both consumers take their shapes from the table', () => {
  const consumers = ['src/core/secret-redaction.ts', 'src/core/loot-detector.ts']

  for (const file of consumers) {
    it(`${file} imports the table and defines no shape of its own`, () => {
      const source = read(file)
      expect(source).toMatch(/from '\.\/secret-patterns'/)
      // Distinctive fragments of shapes that used to be declared inline.
      for (const fragment of ['AKIA[0-9A-Z]', 'ghp_[A-Za-z0-9]', 'PRIVATE KEY-----', 'eyJ[A-Za-z0-9_-]']) {
        expect({ file, fragment, inline: source.includes(fragment) }).toEqual({ file, fragment, inline: false })
      }
    })
  }

  it('does not carry the CTF flag pattern anywhere', () => {
    for (const file of [...consumers, 'src/core/secret-patterns.ts']) {
      expect(read(file)).not.toMatch(/HTB\\\{|ctf\|HTB/)
    }
  })
})
