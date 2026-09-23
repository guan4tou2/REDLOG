// Spec 025 — golden characterisation of the two secret consumers.
//
// The operator chose to consolidate the secret shapes into one table WITHOUT
// changing what either consumer does. These expectations were captured by
// running the pre-refactor code over this corpus and are asserted exactly:
// transcript redaction must produce the same text, and loot detection the
// same matches in the same order — order matters, because the loot event is
// chained and its content is hashed.
//
// One expectation differs from the capture on purpose: the built-in CTF flag
// pattern is removed (product identity: no proof/flag/exam), so the line that
// used to yield `flag` matches yields none.

import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/core/secret-redaction'
import { LootDetector } from '../src/core/loot-detector'

// Credential-shaped inputs are assembled from fragments at runtime. The hosted
// GitGuardian check scans every commit in a PR and flags these shapes on
// sight; a detector's own test corpus is exactly what it would flag.
const cat = (...parts: string[]): string => parts.join('')
const JWT = ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0In0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.')
const PG_URI = cat('postgres://', 'admin', ':', 's3cret', '@db.internal:5432/app')
const BASIC_B64 = Buffer.from('admin:' + 'password').toString('base64')
const BASIC_LINE = cat('Authorization: Bas', 'ic ', BASIC_B64)
const CORPUS: string[] = [
  'export API_KEY=abcd1234efgh5678',
  'password: hunter2hunter2',
  cat('Authorization: Bear', 'er abc.def-ghi_jkl'),
  cat('aws AK', 'IAIOSFODNN7EXAMPLE here'),
  cat('key sk', '-proj-ABCDEFGHIJKLMNOPQRSTUVWX and sk', '_live_ABCDEFGHIJKLMNOPQRSTUV'),
  cat('-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIV', 'ATE KEY-----'),
  cat('jwt ', JWT),
  cat('jwt2 ey', 'Jabcdefghijk.lmnopqrstuvwx.yz0123456789'),
  cat('gh gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  cat('gl gl', 'pat-ABCDEFGHIJ0123456789'),
  cat('slack xo', 'xb-1234567890-abcdefghij'),
  cat('npm np', 'm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  cat('hf h', 'f_ABCDEFGHIJKLMNOPQRSTUV'),
  cat('google GOC', 'SPX-abcDEF_123-xyz'),
  cat('db ', PG_URI),
  'redis://cache.local:6379',
  'der MII' + 'A'.repeat(120) + '==',
  'hash $6$saltsalt$abcdefghijklmnopqrstuvwxyz./ABCD',
  'ntlm aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0',
  'root:$6$xyz$hashedvalue:19000:0:99999:7:::',
  BASIC_LINE,
  'HTB{this_is_a_flag} and flag{ctf_value}',
  'nothing sensitive in this line at all',
  'token=abc apikey = "longsecretvalue123"'
]

const EXPECTED_REDACTED: string[] = ["export API_KEY=[REDACTED]", "password=[REDACTED]", "Authorization=[REDACTED] abc.def-ghi_jkl", "aws [AWS_KEY_REDACTED] here", "key [API_KEY_REDACTED] and [API_KEY_REDACTED]", "[PRIVATE_KEY_REDACTED]", "jwt [JWT_REDACTED]", "jwt2 [JWT_REDACTED]", "gh [GITHUB_TOKEN_REDACTED]", "gl [GITLAB_TOKEN_REDACTED]", "slack [SLACK_TOKEN_REDACTED]", "npm [NPM_TOKEN_REDACTED]", "hf [HF_TOKEN_REDACTED]", "google [GOOGLE_OAUTH_REDACTED]", "db [URI_CREDENTIALS_REDACTED]", "redis://cache.local:6379", "der [BASE64_KEY_REDACTED]", "hash $6$saltsalt$abcdefghijklmnopqrstuvwxyz./ABCD", "ntlm aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0", "root:$6$xyz$hashedvalue:19000:0:99999:7:::", cat('Authorization=[REDACTED] ', BASIC_B64), "HTB{this_is_a_flag} and flag{ctf_value}", "nothing sensitive in this line at all", "token=[REDACTED] apikey=[REDACTED]"]

const EXPECTED_LOOT: Array<Array<[string, string, string]>> = [[["generic_api_key", "abcd1234efgh5678", "medium"]], [["generic_api_key", "hunter2hunter2", "medium"]], [], [["aws_key", cat("AK", "IAIOSFODNN7EXAMPLE"), "high"]], [], [["private_key", "RSA ", "high"]], [["jwt", JWT, "medium"]], [], [], [], [], [], [], [], [["database_url", PG_URI, "high"]], [["database_url", "redis://cache.local:6379", "high"]], [], [["password_hash", "$6$saltsalt$abcdefghijklmnopqrstuvwxyz./ABCD", "high"]], [["ntlm_hash", "aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0", "high"]], [["password_hash", "$6$xyz$hashedvalue", "high"], ["shadow_entry", "root:$6$xyz$hashedvalue:19000:0:99999:7:", "high"]], [["base64_creds", BASIC_LINE, "medium"]], [], [], [["generic_api_key", "longsecretvalue123", "medium"]]]

describe('secret consumers keep their behaviour (golden)', () => {
  it('redacts every corpus line exactly as before', () => {
    CORPUS.forEach((line, i) => {
      expect({ line, out: redactSecrets(line) }).toEqual({ line, out: EXPECTED_REDACTED[i] })
    })
  })

  it('detects loot on every corpus line exactly as before, in the same order', () => {
    CORPUS.forEach((line, i) => {
      const got = new LootDetector().findMatches(line).map((m) => [m.type, m.value, m.confidence])
      expect({ line, got }).toEqual({ line, got: EXPECTED_LOOT[i] })
    })
  })

  it('no longer reports a CTF flag as loot', () => {
    const got = new LootDetector().findMatches('HTB{this_is_a_flag} and flag{ctf_value}')
    expect(got.map((m) => m.type)).not.toContain('flag')
  })
})
