// Every secret shape RedLog recognises, defined once (Spec 025).
//
// Two consumers act on these shapes and used to carry their own copies:
// transcript redaction (`secret-redaction.ts`), which masks secrets in AI
// agent transcripts before they are stored, and loot detection
// (`loot-detector.ts`), which records secrets found in captured output as loot.
// The copies had drifted — a GitHub token was masked but never loot, an NTLM
// hash was loot but never masked — and nothing showed it, because each list
// only looked complete from inside its own file.
//
// The operator chose to consolidate WITHOUT changing either consumer's
// behaviour. So this file holds the shapes, and the two coverage lists below
// reproduce exactly what each consumer did. Where they differ, that difference
// is now the thing you see here, side by side, instead of an accident spread
// across two files. Changing coverage is a policy decision; make it in these
// lists.
//
// Two shapes are near-duplicates on purpose, because the consumers matched
// them differently and the operator chose not to change that:
//   jwt_three_segment vs jwt_with_json_payload
//   private_key_block vs private_key_header
// and `named_secret_assignment` (redaction, masks name and value) differs from
// `named_secret_value` (loot, captures the value) for the same reason.

/** A recognised secret shape. The literal is copied verbatim from the
 *  consumer it came from; `compileShape` hands each caller its own instance,
 *  because a global RegExp carries `lastIndex` state between calls. */
export interface SecretShape {
  pattern: RegExp
  description: string
}

export const SECRET_SHAPES = {
  named_secret_assignment: {
    pattern: /(?<name>api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization)[=: ]+\S+/gi,
    description: '`api_key=` / `token:` / `password ` style assignment, value to end of token'
  },
  bearer_token: {
    pattern: /bearer\s+[A-Za-z0-9_\-.]+/gi,
    description: '`Bearer <token>`'
  },
  aws_access_key: {
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS access key id'
  },
  prefixed_api_key: {
    pattern: /(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}/gi,
    description: '`sk-` / `sk_live_` / `sk_test_` prefixed API key'
  },
  private_key_block: {
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    description: 'a whole PEM private key block, header to footer'
  },
  jwt_three_segment: {
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    description: 'any three dot-separated base64url segments starting `eyJ`'
  },
  github_pat: {
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    description: 'GitHub personal access token'
  },
  gitlab_pat: {
    pattern: /glpat-[A-Za-z0-9_-]{20}/g,
    description: 'GitLab personal access token'
  },
  slack_token: {
    pattern: /xox[bpsa]-[A-Za-z0-9-]{10,}/g,
    description: 'Slack token'
  },
  npm_token: {
    pattern: /npm_[A-Za-z0-9]{36,}/g,
    description: 'npm token'
  },
  huggingface_token: {
    pattern: /hf_[A-Za-z0-9]{20,}/g,
    description: 'Hugging Face token'
  },
  google_oauth_client_secret: {
    pattern: /GOCSPX-[A-Za-z0-9_-]+/g,
    description: 'Google OAuth client secret'
  },
  uri_userinfo_credentials: {
    pattern: /[a-z+]+:\/\/[^/:@\s]+:[^/@\s]+@[^\s]+/gi,
    description: '`scheme://user:pass@host` credentials in a URI'
  },
  der_base64_key: {
    pattern: /MII[A-Za-z0-9+/]{100,}={0,2}/g,
    description: 'DER key material in base64 (`MII…`)'
  },
  crypt_password_hash: {
    pattern: /\$[126][\$a-z]*\$[./A-Za-z0-9]+/g,
    description: 'crypt(3) password hash (`$1$`, `$2*$`, `$6$`)'
  },
  ntlm_hash_pair: {
    pattern: /[a-fA-F0-9]{32}:[a-fA-F0-9]{32}/g,
    description: 'LM:NT hash pair'
  },
  private_key_header: {
    // The first line of key material is part of the match so two keys with
    // the same header are two values (Spec 031); the header alone is not the
    // secret. The algorithm is a non-capturing group — it is not the value.
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{16,})?/g,
    description: 'a PEM private key header, with its first line of key material when present'
  },
  jwt_with_json_payload: {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    description: 'a JWT whose payload segment also starts `eyJ`'
  },
  named_secret_value: {
    pattern: /(?:api[_-]?key|apikey|token|secret|password)\s*[=:]\s*['"]?([^\s'"]{8,})/gi,
    description: '`api_key=` / `token:` style assignment, capturing the value (8+ chars)'
  },
  database_url: {
    pattern: /(?:mysql|postgres|mongodb|redis):\/\/[^\s]+/gi,
    description: 'mysql/postgres/mongodb/redis connection URL'
  },
  shadow_entry: {
    pattern: /^[a-z_][a-z0-9_-]*:\$[^:]+:[^:]*:[^:]*:[^:]*:[^:]*:/gm,
    description: 'an /etc/shadow line with a hash'
  },
  basic_auth_header: {
    pattern: /(?:Authorization|auth):\s*Basic\s+[A-Za-z0-9+/=]{10,}/gi,
    description: '`Authorization: Basic <base64>`'
  }
} satisfies Record<string, SecretShape>

export type SecretShapeId = keyof typeof SECRET_SHAPES

/** A fresh RegExp for one shape — never share the table's instance. */
export function compileShape(id: SecretShapeId): RegExp {
  const { pattern } = SECRET_SHAPES[id]
  return new RegExp(pattern.source, pattern.flags)
}

// ─── Coverage: who acts on which shape ──────────────────────────────────────

/** Masked in AI agent transcripts before storage, in this order — each
 *  replacement runs over the previous one's output. */
export const REDACT_IN_TRANSCRIPTS: ReadonlyArray<{ shape: SecretShapeId; replacement: string }> = [
  { shape: 'named_secret_assignment', replacement: '$<name>=[REDACTED]' },
  { shape: 'bearer_token', replacement: 'Bearer [REDACTED]' },
  { shape: 'aws_access_key', replacement: '[AWS_KEY_REDACTED]' },
  { shape: 'prefixed_api_key', replacement: '[API_KEY_REDACTED]' },
  { shape: 'private_key_block', replacement: '[PRIVATE_KEY_REDACTED]' },
  { shape: 'jwt_three_segment', replacement: '[JWT_REDACTED]' },
  { shape: 'github_pat', replacement: '[GITHUB_TOKEN_REDACTED]' },
  { shape: 'gitlab_pat', replacement: '[GITLAB_TOKEN_REDACTED]' },
  { shape: 'slack_token', replacement: '[SLACK_TOKEN_REDACTED]' },
  { shape: 'npm_token', replacement: '[NPM_TOKEN_REDACTED]' },
  { shape: 'huggingface_token', replacement: '[HF_TOKEN_REDACTED]' },
  { shape: 'google_oauth_client_secret', replacement: '[GOOGLE_OAUTH_REDACTED]' },
  { shape: 'uri_userinfo_credentials', replacement: '[URI_CREDENTIALS_REDACTED]' },
  { shape: 'der_base64_key', replacement: '[BASE64_KEY_REDACTED]' }
]

/** Cheap pre-check for `REDACT_IN_TRANSCRIPTS`: text matching none of these
 *  markers cannot match any shape above, so redaction skips it. It lives here
 *  because it must cover every redacted shape — a shape added to the list but
 *  not to this marker set would be silently skipped for every input. A test
 *  asserts that coverage for each shape's sample. */
export const TRANSCRIPT_PREFILTER = /api[_-]?key|api[_-]?secret|token|password|passwd|secret|authorization|bearer|AKIA|sk[-_]|BEGIN|eyJ|ghp_|glpat|xox[bpsa]-|npm_|hf_|GOCSPX|:\/\/[^/:@\s]+:[^/@\s]+@|MII[A-Za-z0-9+/]{20}/i

/** Recorded as loot, in this order — the match order is the order of the loot
 *  event's `matches`, which is chained, so it must not change. `type` is the
 *  value stored on the event. `group` is which part of the match is the value:
 *  0 for the whole match, n for capture group n — never inferred (Spec 031).
 *  The CTF flag pattern that used to follow
 *  `shadow_entry` was removed (product identity: no proof/flag/exam). */
export const DETECT_AS_LOOT: ReadonlyArray<{ shape: SecretShapeId; type: string; confidence: 'high' | 'medium' | 'low'; group: number }> = [
  { shape: 'crypt_password_hash', type: 'password_hash', confidence: 'high', group: 0 },
  { shape: 'ntlm_hash_pair', type: 'ntlm_hash', confidence: 'high', group: 0 },
  { shape: 'private_key_header', type: 'private_key', confidence: 'high', group: 0 },
  { shape: 'aws_access_key', type: 'aws_key', confidence: 'high', group: 0 },
  { shape: 'jwt_with_json_payload', type: 'jwt', confidence: 'medium', group: 0 },
  { shape: 'named_secret_value', type: 'generic_api_key', confidence: 'medium', group: 1 },
  { shape: 'database_url', type: 'database_url', confidence: 'high', group: 0 },
  { shape: 'shadow_entry', type: 'shadow_entry', confidence: 'high', group: 0 },
  { shape: 'basic_auth_header', type: 'base64_creds', confidence: 'medium', group: 0 }
]
